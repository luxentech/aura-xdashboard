/**
 * AURA-X Cloud Database Configuration
 * 
 * يمكنك استخدام قاعدة البيانات السحابية الجاهزة تلقائياً دون أي تعديل،
 * أو ربط مشروع Firebase خاص بك إذا أردت بالأسفل.
 */
window.AURA_CLOUD_CONFIG = {
  // اسم النطاق السحابي لحفظ المستخدمين عبر الإنترنت
  cloudBucketId: "aurax_cloud_fleet_v1",
  
  // خيارات Firebase (اختياري - إن أردت ربط حساب Firebase خاص بك)
  firebase: {
    enabled: false, // غيّر إلى true عند وضع بياناتك
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  }
};
