'use strict';
// Google OAuth client for the app. Copy this file to `google-config.js` and fill
// in a "Desktop app" OAuth client from Google Cloud Console → Credentials.
//
// google-config.js is gitignored, so real credentials never land in the public
// repo. They ARE bundled into distributed builds (.exe); per Google, an installed
// app's client secret is not confidential, and PKCE protects the auth exchange.
//
// Setup: enable "YouTube Data API v3", configure the OAuth consent screen
// (scope: .../auth/youtube.readonly), then create a Desktop-app OAuth client.
module.exports = {
  clientId: '',      // e.g. 1234567890-abc.apps.googleusercontent.com
  clientSecret: '',  // e.g. GOCSPX-xxxxxxxx
};
