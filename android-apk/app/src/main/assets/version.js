/* The one place the app's version number lives.

   It used to be typed straight into index.html as "1.0.0" and never touched
   again, so the About page reported 1.0.0 while the installed package was
   1.2.0 - the one screen whose entire job is to tell you what you are running.

   android-apk/build.sh rewrites QUANTA_VERSION in the copy it packages, from the
   VERSION_NAME it is given, so the number here and the number in the APK cannot
   drift apart. The build fails if it cannot find the line to rewrite. */

window.QUANTA_VERSION = "1.6.2";
