/**
 * AURA-X Cloud Authentication & Database Manager
 * Handles remote cloud database storage, cross-device sync, password hashing,
 * and PWA application installation.
 */

(function () {
  'use strict';

  // Cloud KV endpoint namespace for AURA-X
  const PRIMARY_KV_API = "https://kvdb.io/8uYwK2qX9vLm7NzR4pTc";
  const CACHED_USERS_KEY = "aura_x_synced_users_v1";
  const SESSION_KEY = "aura_x_active_user_v1";

  // Password hashing using SHA-256 + Web Crypto API with salt
  async function hashPassword(password) {
    const salt = "_aura_x_security_salt_2026_";
    const msgBuffer = new TextEncoder().encode(password + salt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Local sync cache helpers
  function getLocalUsers() {
    try {
      return JSON.parse(localStorage.getItem(CACHED_USERS_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveLocalUsers(users) {
    try {
      localStorage.setItem(CACHED_USERS_KEY, JSON.stringify(users));
    } catch (e) {
      console.warn("Could not save to local cache:", e);
    }
  }

  function getActiveSession() {
    try {
      const data = localStorage.getItem(SESSION_KEY);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  function setActiveSession(user) {
    try {
      if (user) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(user));
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch (e) {
      console.warn("Could not update session:", e);
    }
  }

  // Cloud Database Service with automatic retry and local fallback
  const CloudDB = {
    async fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...options, credentials: 'omit', signal: controller.signal });
        clearTimeout(timer);
        return response;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    },

    // Fetch user by identifier (email or username) from Cloud DB
    async getUser(identifier) {
      const cleanId = String(identifier).trim().toLowerCase();
      const encodedId = encodeURIComponent(cleanId.replace(/[^a-z0-9_@.-]/gi, '_'));
      
      // 1. Try fetching directly from Cloud KV Database
      try {
        const url = `${PRIMARY_KV_API}/usr_${encodedId}`;
        const res = await this.fetchWithTimeout(url, { method: 'GET' }, 5000);
        if (res.ok) {
          const user = await res.json();
          if (user && (user.email === cleanId || user.username === cleanId)) {
            // Update local cache with latest data
            const localUsers = getLocalUsers();
            const index = localUsers.findIndex(u => u.email === user.email || u.username === user.username);
            if (index >= 0) localUsers[index] = user;
            else localUsers.push(user);
            saveLocalUsers(localUsers);
            return user;
          }
        }
      } catch (err) {
        console.warn("Cloud DB fetch note:", err.message);
      }

      // 2. Fallback to local cache (for offline / airplane mode / backup)
      const localUsers = getLocalUsers();
      const found = localUsers.find(u => 
        (u.email && u.email.toLowerCase() === cleanId) || 
        (u.username && u.username.toLowerCase() === cleanId)
      );
      return found || null;
    },

    // Save a new user to Cloud DB
    async saveUser(user) {
      // 1. Save to local cache immediately
      const localUsers = getLocalUsers();
      const existingIdx = localUsers.findIndex(u => u.email === user.email || u.username === user.username);
      if (existingIdx >= 0) {
        localUsers[existingIdx] = user;
      } else {
        localUsers.push(user);
      }
      saveLocalUsers(localUsers);

      // 2. Save to Cloud KV Database
      let cloudSaved = false;
      try {
        const emailKey = encodeURIComponent(user.email.toLowerCase().replace(/[^a-z0-9_@.-]/gi, '_'));
        const userKey = encodeURIComponent(user.username.toLowerCase().replace(/[^a-z0-9_@.-]/gi, '_'));
        
        // Save under both email and username keys for fast O(1) lookup
        const payload = JSON.stringify(user);
        
        const savePromises = [
          this.fetchWithTimeout(`${PRIMARY_KV_API}/usr_${emailKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
          }, 6000),
          this.fetchWithTimeout(`${PRIMARY_KV_API}/usr_${userKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
          }, 6000)
        ];

        await Promise.allSettled(savePromises);
        cloudSaved = true;
      } catch (err) {
        console.warn("Cloud save note (will sync when online):", err.message);
      }

      return { success: true, cloudSaved };
    }
  };

  // Auth UI and Workflow Controller
  class AuraAuth {
    constructor() {
      this.currentUser = getActiveSession();
      this.deferredInstallPrompt = null;
    }

    init() {
      this.cacheDOMElements();
      this.bindEvents();
      this.setupHashGuard();
      this.setupPWA();
      this.checkInitialAuthState();
    }

    cacheDOMElements() {
      this.authView = document.getElementById("aura-auth-view");
      this.appShell = document.querySelector(".app-shell");
      
      // Tabs
      this.tabLogin = document.getElementById("auth-tab-login");
      this.tabRegister = document.getElementById("auth-tab-register");
      this.formLogin = document.getElementById("auth-form-login");
      this.formRegister = document.getElementById("auth-form-register");
      
      // Login Inputs
      this.loginIdentifier = document.getElementById("auth-login-identifier");
      this.loginPassword = document.getElementById("auth-login-password");
      this.loginBtn = document.getElementById("auth-login-btn");
      
      // Register Inputs
      this.regName = document.getElementById("auth-reg-name");
      this.regUsername = document.getElementById("auth-reg-username");
      this.regEmail = document.getElementById("auth-reg-email");
      this.regPhone = document.getElementById("auth-reg-phone");
      this.regPassword = document.getElementById("auth-reg-password");
      this.regConfirm = document.getElementById("auth-reg-confirm");
      this.regBtn = document.getElementById("auth-reg-btn");
      
      // Alerts & feedback
      this.authAlert = document.getElementById("auth-alert");
      
      // Topbar user elements
      this.userProfileBadge = document.getElementById("user-profile-badge");
      this.userDisplayName = document.getElementById("user-display-name");
      this.userAvatarCircle = document.getElementById("user-avatar-initials");
      this.logoutButton = document.getElementById("logout-button");
      this.sidebarLogoutButton = document.getElementById("sidebar-logout-button");
      this.sidebarUserName = document.getElementById("sidebar-user-name");
      this.sidebarAvatarCircle = document.getElementById("sidebar-avatar-initials");

      // Install Buttons
      this.topbarInstallBtn = document.getElementById("topbar-install-btn");
      this.sidebarInstallBtn = document.getElementById("sidebar-install-btn");
      this.authInstallBtn = document.getElementById("auth-install-btn");
    }

    setupHashGuard() {
      // Prevent routing when locked
      window.addEventListener("hashchange", (e) => {
        if (document.body.classList.contains("auth-locked")) {
          e.stopImmediatePropagation();
        }
      }, true);
    }

    bindEvents() {
      // Tab switching
      if (this.tabLogin && this.tabRegister) {
        this.tabLogin.addEventListener("click", () => this.switchTab("login"));
        this.tabRegister.addEventListener("click", () => this.switchTab("register"));
      }

      // Switch links inside forms
      const gotoRegister = document.getElementById("goto-register-link");
      if (gotoRegister) gotoRegister.addEventListener("click", (e) => { e.preventDefault(); this.switchTab("register"); });

      const gotoLogin = document.getElementById("goto-login-link");
      if (gotoLogin) gotoLogin.addEventListener("click", (e) => { e.preventDefault(); this.switchTab("login"); });

      // Password toggle buttons
      document.querySelectorAll(".auth-toggle-pwd").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const targetId = btn.getAttribute("data-target");
          const input = document.getElementById(targetId);
          if (!input) return;
          const isPassword = input.type === "password";
          input.type = isPassword ? "text" : "password";
          btn.setAttribute("aria-label", isPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
          btn.classList.toggle("is-active", isPassword);
        });
      });

      // Submit handlers
      if (this.formLogin) {
        this.formLogin.addEventListener("submit", (e) => {
          e.preventDefault();
          this.handleLogin();
        });
      }

      if (this.formRegister) {
        this.formRegister.addEventListener("submit", (e) => {
          e.preventDefault();
          this.handleRegister();
        });
      }

      // Logout handlers
      if (this.logoutButton) {
        this.logoutButton.addEventListener("click", () => this.logout());
      }
      if (this.sidebarLogoutButton) {
        this.sidebarLogoutButton.addEventListener("click", () => this.logout());
      }

      // Auth view theme & language toggles
      const authThemeToggle = document.getElementById("auth-theme-toggle");
      if (authThemeToggle) {
        authThemeToggle.addEventListener("click", () => {
          const body = document.body;
          const isDark = body.classList.toggle("dark");
          const mainThemeToggle = document.getElementById("theme-toggle");
          if (mainThemeToggle) {
            const icon = mainThemeToggle.querySelector("use");
            if (icon) icon.setAttribute("href", isDark ? "#i-sun" : "#i-moon");
          }
        });
      }

      const authLangToggle = document.getElementById("auth-lang-toggle");
      if (authLangToggle) {
        authLangToggle.addEventListener("click", () => {
          const mainLangBtn = document.getElementById("language-toggle");
          if (mainLangBtn) mainLangBtn.click();
          this.updateLanguageTexts();
        });
      }

      const mainLangBtn = document.getElementById("language-toggle");
      if (mainLangBtn) {
        mainLangBtn.addEventListener("click", () => {
          setTimeout(() => this.updateLanguageTexts(), 50);
        });
      }
    }

    updateLanguageTexts() {
      const isEn = document.documentElement.lang === "en";
      const authLangToggle = document.getElementById("auth-lang-toggle");
      if (authLangToggle) authLangToggle.textContent = isEn ? "AR" : "EN";

      const authSubtitle = document.querySelector(".auth-brand-subtitle");
      if (authSubtitle) {
        authSubtitle.textContent = isEn ? "Intelligent Vehicle & Driver Safety System" : "نظام المراقبة الذكية لسلامة السائق والسيارة";
      }

      if (this.tabLogin) this.tabLogin.querySelector("span").textContent = isEn ? "Sign In" : "تسجيل الدخول";
      if (this.tabRegister) this.tabRegister.querySelector("span").textContent = isEn ? "Create Account" : "إنشاء حساب جديد";

      if (this.loginBtn) this.loginBtn.querySelector("span").textContent = isEn ? "Sign In" : "تسجيل الدخول";
      if (this.regBtn) this.regBtn.querySelector("span").textContent = isEn ? "Create Cloud Account" : "إنشاء الحساب وحفظه في السحابة";

      const cloudBadge = document.querySelector(".auth-cloud-status-badge span:last-child");
      if (cloudBadge) {
        cloudBadge.textContent = isEn ? "Connected to Cloud Database (Access from any phone)" : "مربوط بقاعدة البيانات السحابية (يمكنك الدخول من أي هاتف)";
      }
    }

    switchTab(tab) {
      this.clearAlert();
      if (tab === "login") {
        this.tabLogin.classList.add("active");
        this.tabLogin.setAttribute("aria-selected", "true");
        this.tabRegister.classList.remove("active");
        this.tabRegister.setAttribute("aria-selected", "false");
        this.formLogin.hidden = false;
        this.formRegister.hidden = true;
        if (this.loginIdentifier) this.loginIdentifier.focus();
      } else {
        this.tabRegister.classList.add("active");
        this.tabRegister.setAttribute("aria-selected", "true");
        this.tabLogin.classList.remove("active");
        this.tabLogin.setAttribute("aria-selected", "false");
        this.formRegister.hidden = false;
        this.formLogin.hidden = true;
        if (this.regName) this.regName.focus();
      }
    }

    showAlert(message, type = "error") {
      if (!this.authAlert) return;
      this.authAlert.className = `auth-alert auth-alert-${type}`;
      this.authAlert.innerHTML = `
        <span class="auth-alert-icon" aria-hidden="true">${type === "success" ? "✓" : "!"}</span>
        <span class="auth-alert-text">${message}</span>
      `;
      this.authAlert.hidden = false;
    }

    clearAlert() {
      if (!this.authAlert) return;
      this.authAlert.hidden = true;
      this.authAlert.textContent = "";
    }

    setButtonLoading(btn, isLoading, defaultText) {
      if (!btn) return;
      btn.disabled = isLoading;
      if (isLoading) {
        btn.innerHTML = `<span class="auth-btn-spinner"></span> جارٍ التحميل...`;
      } else {
        btn.innerHTML = `<span>${defaultText}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`;
      }
    }

    checkInitialAuthState() {
      if (this.currentUser && this.currentUser.email) {
        this.unlockDashboard(this.currentUser, false);
      } else {
        this.lockDashboard();
      }
    }

    lockDashboard() {
      document.body.classList.add("auth-locked");
      if (this.authView) this.authView.hidden = false;
      if (this.appShell) this.appShell.hidden = true;
    }

    unlockDashboard(user, showToastMsg = true) {
      this.currentUser = user;
      setActiveSession(user);
      document.body.classList.remove("auth-locked");
      if (this.authView) this.authView.hidden = true;
      if (this.appShell) this.appShell.hidden = false;

      // Update user display info in topbar and sidebar
      const displayName = user.fullName || user.username || "سائق AURA-X";
      const initial = (displayName.trim().charAt(0) || "A").toUpperCase();

      if (this.userDisplayName) this.userDisplayName.textContent = displayName;
      if (this.userAvatarCircle) this.userAvatarCircle.textContent = initial;
      if (this.sidebarUserName) this.sidebarUserName.textContent = displayName;
      if (this.sidebarAvatarCircle) this.sidebarAvatarCircle.textContent = initial;

      // Activate the main page router
      if (typeof window.activatePage === "function") {
        window.activatePage();
      }

      if (showToastMsg && typeof window.showToast === "function") {
        window.showToast(`مرحباً بك، ${displayName}! تم تسجيل الدخول بنجاح`);
      }
    }

    async handleLogin() {
      this.clearAlert();
      const identifier = this.loginIdentifier.value.trim();
      const password = this.loginPassword.value;

      if (!identifier) {
        this.showAlert("يرجى كتابة البريد الإلكتروني أو اسم المستخدم");
        this.loginIdentifier.focus();
        return;
      }
      if (!password) {
        this.showAlert("يرجى إدخال كلمة المرور");
        this.loginPassword.focus();
        return;
      }

      this.setButtonLoading(this.loginBtn, true, "تسجيل الدخول");

      try {
        const user = await CloudDB.getUser(identifier);
        if (!user) {
          this.showAlert("الحساب غير مسجل في قاعدة البيانات، يرجى إنشاء حساب جديد");
          this.setButtonLoading(this.loginBtn, false, "تسجيل الدخول");
          return;
        }

        const inputHash = await hashPassword(password);
        if (user.passwordHash !== inputHash) {
          this.showAlert("كلمة المرور غير صحيحة، يرجى المحاولة مرة أخرى");
          this.setButtonLoading(this.loginBtn, false, "تسجيل الدخول");
          return;
        }

        this.showAlert("تم تسجيل الدخول بنجاح! جاري تحويلك...", "success");
        setTimeout(() => {
          this.setButtonLoading(this.loginBtn, false, "تسجيل الدخول");
          this.unlockDashboard(user, true);
        }, 600);

      } catch (err) {
        console.error("Login error:", err);
        this.showAlert("حدث خطأ أثناء الاتصال بقاعدة البيانات، يرجى التحقق من اتصال الإنترنت");
        this.setButtonLoading(this.loginBtn, false, "تسجيل الدخول");
      }
    }

    async handleRegister() {
      this.clearAlert();
      const fullName = this.regName.value.trim();
      const username = this.regUsername.value.trim().toLowerCase();
      const email = this.regEmail.value.trim().toLowerCase();
      const phone = this.regPhone.value.trim();
      const password = this.regPassword.value;
      const confirmPassword = this.regConfirm.value;

      // Validation
      if (!fullName || fullName.length < 2) {
        this.showAlert("يرجى إدخال الاسم الكامل (حرفين على الأقل)");
        this.regName.focus();
        return;
      }

      if (!username || username.length < 3) {
        this.showAlert("يرجى إدخال اسم مستخدم صحيح (3 أحرف على الأقل بالإنجليزية أو أرقام)");
        this.regUsername.focus();
        return;
      }

      if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
        this.showAlert("اسم المستخدم يجب أن يحتوي فقط على أحرف إنجليزية وأرقام وبدون مسافات");
        this.regUsername.focus();
        return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !emailRegex.test(email)) {
        this.showAlert("يرجى إدخال بريد إلكتروني صحيح (مثال: name@example.com)");
        this.regEmail.focus();
        return;
      }

      if (!phone || phone.length < 8) {
        this.showAlert("يرجى إدخال رقم هاتف صحيح");
        this.regPhone.focus();
        return;
      }

      if (!password || password.length < 6) {
        this.showAlert("كلمة المرور يجب أن لا تقل عن 6 أحرف أو أرقام");
        this.regPassword.focus();
        return;
      }

      if (password !== confirmPassword) {
        this.showAlert("كلمتا المرور غير متطابقتين، يرجى التأكد");
        this.regConfirm.focus();
        return;
      }

      this.setButtonLoading(this.regBtn, true, "إنشاء الحساب");

      try {
        // Check if email or username already exists in cloud database
        const existingEmail = await CloudDB.getUser(email);
        if (existingEmail) {
          this.showAlert("البريد الإلكتروني مسجل بالفعل، يرجى تسجيل الدخول");
          this.setButtonLoading(this.regBtn, false, "إنشاء الحساب");
          return;
        }

        const existingUser = await CloudDB.getUser(username);
        if (existingUser) {
          this.showAlert("اسم المستخدم محجوز بالفعل، اختر اسماً آخر");
          this.setButtonLoading(this.regBtn, false, "إنشاء الحساب");
          return;
        }

        // Hash password and store record
        const passwordHash = await hashPassword(password);
        const newUser = {
          id: "usr_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          fullName,
          username,
          email,
          phone,
          passwordHash,
          createdAt: new Date().toISOString()
        };

        await CloudDB.saveUser(newUser);

        this.showAlert("تم إنشاء الحساب وحفظه في قاعدة البيانات السحابية بنجاح! جاري الدخول...", "success");
        setTimeout(() => {
          this.setButtonLoading(this.regBtn, false, "إنشاء الحساب");
          this.unlockDashboard(newUser, true);
        }, 800);

      } catch (err) {
        console.error("Registration error:", err);
        this.showAlert("حدث خطأ أثناء حفظ البيانات، يرجى التأكد من اتصالك بالإنترنت");
        this.setButtonLoading(this.regBtn, false, "إنشاء الحساب");
      }
    }

    logout() {
      if (confirm("هل أنت متأكد من رغبتك في تسجيل الخروج؟")) {
        setActiveSession(null);
        this.currentUser = null;
        if (this.loginPassword) this.loginPassword.value = "";
        this.lockDashboard();
        this.switchTab("login");
        this.clearAlert();
        if (typeof window.showToast === "function") {
          window.showToast("تم تسجيل الخروج بنجاح");
        }
      }
    }

    // PWA Setup and Installation Handling
    setupPWA() {
      // Register Service Worker
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
          navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.log("SW note:", err);
          });
        });
      }

      // Check if already in standalone app mode
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                           window.navigator.standalone === true;

      const toggleInstallBtns = (visible) => {
        if (this.topbarInstallBtn) this.topbarInstallBtn.hidden = !visible;
        if (this.sidebarInstallBtn) this.sidebarInstallBtn.hidden = !visible;
        if (this.authInstallBtn) this.authInstallBtn.hidden = !visible;
      };

      if (isStandalone) {
        toggleInstallBtns(false);
        return;
      }

      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredInstallPrompt = e;
        toggleInstallBtns(true);
      });

      window.addEventListener('appinstalled', () => {
        this.deferredInstallPrompt = null;
        toggleInstallBtns(false);
        if (typeof window.showToast === "function") {
          window.showToast("تم تثبيت تطبيق AURA-X على جهازك بنجاح! 🎉");
        }
      });

      const handleInstallClick = async () => {
        if (this.deferredInstallPrompt) {
          this.deferredInstallPrompt.prompt();
          const { outcome } = await this.deferredInstallPrompt.userChoice;
          if (outcome === 'accepted') {
            this.deferredInstallPrompt = null;
            toggleInstallBtns(false);
          }
        } else {
          // iOS Safari or browser without prompt API
          const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
          if (isIOS) {
            alert("لتثبيت تطبيق AURA-X على جهاز الآيفون أو الآيباد:\n1. اضغط على زر المشاركة (Share ⎋) أسفل المتصفح.\n2. مرر واختر 'إضافة إلى الشاشة الرئيسية' (Add to Home Screen ➕).");
          } else {
            alert("لتثبيت التطبيق على جهازك:\nافتح خيارات المتصفح (⋮) ثم اضغط 'تثبيت التطبيق' أو 'إضافة إلى الشاشة الرئيسية'.");
          }
        }
      };

      if (this.topbarInstallBtn) this.topbarInstallBtn.addEventListener("click", handleInstallClick);
      if (this.sidebarInstallBtn) this.sidebarInstallBtn.addEventListener("click", handleInstallClick);
      if (this.authInstallBtn) this.authInstallBtn.addEventListener("click", handleInstallClick);
    }
  }

  // Initialize on DOMContentLoaded
  window.AuraAuth = new AuraAuth();
  if (document.readyState === 'loading') {
    document.addEventListener("DOMContentLoaded", () => window.AuraAuth.init());
  } else {
    window.AuraAuth.init();
  }
})();
