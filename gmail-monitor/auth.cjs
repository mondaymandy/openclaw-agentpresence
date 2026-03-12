/**
 * Gmail OAuth2 Authentication
 * Handles token storage and refresh for Gmail API access.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'];

/**
 * Load saved credentials if they exist.
 */
function loadSavedToken() {
  try {
    const content = fs.readFileSync(TOKEN_PATH, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save token to disk for future use.
 */
function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log('Token saved to', TOKEN_PATH);
}

/**
 * Create an OAuth2 client from credentials.
 */
function createOAuth2Client() {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const credentials = JSON.parse(content);
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret || '', redirect_uris[0]);
}

/**
 * Get authenticated OAuth2 client.
 * If no saved token, starts a local server for OAuth callback.
 */
async function getAuthClient() {
  const oauth2Client = createOAuth2Client();
  const savedToken = loadSavedToken();

  if (savedToken) {
    oauth2Client.setCredentials(savedToken);
    // Set up auto-save on token refresh
    oauth2Client.on('tokens', (tokens) => {
      const currentToken = loadSavedToken() || {};
      const updatedToken = { ...currentToken, ...tokens };
      saveToken(updatedToken);
    });
    return oauth2Client;
  }

  // No saved token — need to authorize interactively
  console.log('No saved token found. Starting OAuth flow...');
  const token = await authorizeInteractive(oauth2Client);
  oauth2Client.setCredentials(token);
  saveToken(token);
  return oauth2Client;
}

/**
 * Interactive OAuth: opens browser, waits for callback.
 */
function authorizeInteractive(oauth2Client) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
        const code = qs.get('code');
        if (!code) {
          res.end('No code received');
          return;
        }
        res.end('Authentication successful! You can close this tab.');
        server.close();

        const { tokens } = await oauth2Client.getToken(code);
        resolve(tokens);
      } catch (e) {
        reject(e);
      }
    });

    server.listen(3000, () => {
      // Update redirect URI to match the server
      oauth2Client.redirectUri = 'http://localhost:3000';
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        redirect_uri: 'http://localhost:3000',
      });
      console.log('\n🔑 Authorize by visiting this URL:\n');
      console.log(authUrl);
      console.log('\nWaiting for authorization...\n');

      // Try to open in browser
      const { exec } = require('child_process');
      exec(`open "${authUrl}"`);
    });
  });
}

module.exports = { getAuthClient, createOAuth2Client, SCOPES };
