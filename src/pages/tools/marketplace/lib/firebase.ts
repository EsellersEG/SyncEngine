import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';

let firebaseConfig: any = null;

export const loadFirebaseConfig = async () => {
  if (firebaseConfig) return firebaseConfig;
  try {
    const response = await fetch('/firebase-applet-config.json');
    if (!response.ok) throw new Error('Not found');
    firebaseConfig = await response.json();
    return firebaseConfig;
  } catch (e) {
    console.warn("firebase-applet-config.json not found in public folder.");
    return null;
  }
};

let app: any = null;
let authInstance: any = null;

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/spreadsheets');
provider.addScope('https://www.googleapis.com/auth/userinfo.email');
provider.addScope('https://www.googleapis.com/auth/userinfo.profile');

export const getAuthInstance = async () => {
  if (authInstance) return authInstance;
  const config = await loadFirebaseConfig();
  if (!config) return null;

  if (!app) {
    app = initializeApp(config);
    authInstance = getAuth(app);
  }
  return authInstance;
};

let isSigningIn = false;
let cachedAccessToken: string | null = null;

export const initAuth = async (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  const auth = await getAuthInstance();
  if (!auth) {
    if (onAuthFailure) onAuthFailure();
    return () => {};
  }

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  const auth = await getAuthInstance();
  if (!auth) throw new Error("Firebase Auth not initialized. Check firebase-applet-config.json in public folder.");

  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Google');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const marketplaceLogout = async () => {
  const auth = await getAuthInstance();
  if (auth) {
    await auth.signOut();
  }
  cachedAccessToken = null;
};
