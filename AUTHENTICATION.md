# Firebase Authentication Implementation

## Overview

This document describes the authentication implementation that ensures only authorized users can write to Firestore.

## Problem Statement

The application had Firestore security rules requiring authentication (`request.auth != null`) for write operations, but the client-side code never authenticated users with Firebase Auth. This caused all write operations to fail with permission denied errors.

## Solution

Implemented Firebase Google Sign-In Authentication to sign in users before they perform any write operations. Users are prompted with the Google sign-in popup after entering a correct PIN.

## Implementation Details

### 1. Authentication Helper Function

Added `ensureAuthenticated()` function that checks if a user is authenticated before allowing Firestore writes:

```javascript
async function ensureAuthenticated() {
  if (!auth) {
    throw new Error('Firebase authentication not available');
  }
  if (!auth.currentUser) {
    throw new Error('User not authenticated. Please enter edit mode first.');
  }
  return true;
}
```

### 2. Authentication on Edit Mode Entry

Modified `enterEditMode()` to sign in users with Google when they enter a valid PIN:

```javascript
async function enterEditMode() {
  // Authenticate with Firebase before enabling edit mode
  try {
    if (auth && !auth.currentUser) {
      console.log('Authenticating with Firebase...');
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
      console.log('Firebase authentication successful');
    }
    // ... rest of edit mode logic
  } catch (error) {
    console.error('Firebase authentication failed:', error);
    alert('Authentication failed: ' + error.message);
    return;
  }
}
```

### 3. Authentication for Parent Snack Claims

Since parents can claim snacks without entering edit mode, the `saveSnackDataToFirestore()` function now authenticates users automatically with Google Sign-In:

```javascript
async function saveSnackDataToFirestore() {
  try {
    // Authenticate if not already authenticated (for parent snack claims)
    if (auth && !auth.currentUser) {
      console.log('Authenticating for snack claim...');
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
      console.log('Authentication successful');
    }
    // ... save logic
  }
}
```

### 4. Protected Save Functions

All save functions now call `ensureAuthenticated()` before writing to Firestore:

- `saveChangesToFirestore()` - Main save for all editable fields
- `saveShoutoutsToFirebase()` - Student shoutouts
- `saveTransportationField()` - Transportation information
- `saveMainMessage()` - TV display message
- `saveBirthdayField()` - Individual birthday field
- `saveAllBirthdays()` - All birthday fields
- `saveAboutMeField()` - About Me section fields
- `saveExtrasCards()` - Extra information cards
- `saveWebsiteUrls()` - Practice website URLs
- `saveSnackMessage()` - Snack message

## Firestore Security Rules

The Firestore rules require authentication for writes:

```javascript
match /classData/{document} {
  allow read: if true;
  allow write: if request.auth != null;
}

match /shoutouts/{document} {
  allow read: if true;
  allow write: if request.auth != null;
}
```

## User Experience

### For Teachers/Admins
1. Click "Edit Mode" button
2. Enter PIN (2213 for teacher)
3. Google Sign-In popup appears
4. User signs in with their Google account
5. Edit mode is enabled and all save operations now succeed

### For Parents (Snack Claims)
1. Check snack checkbox and enter name
2. Click "Save" button
3. Google Sign-In popup appears automatically
4. User signs in with their Google account
5. Snack claim is saved successfully

## Error Handling

If authentication fails, users see:
- Alert message with specific error details
- Save buttons show "❌ Save Failed" state
- Console logs provide debugging information

## Testing

To verify authentication is working:

1. **Console Verification**:
   - Open browser console
   - Enter edit mode with PIN
   - Look for: "Firebase authentication successful"
   - Make changes and save
   - Look for: "Data saved successfully to Firestore"

2. **Snack Claim Test**:
   - Without entering edit mode
   - Claim a snack
   - Check console for: "Authenticating for snack claim..."
   - Verify: "Snack data saved to Firestore successfully"

3. **Unauthenticated Write Attempt**:
   - If authentication is bypassed, Firestore will reject writes
   - Console will show permission denied errors

## Security Considerations

### Google Sign-In Authentication
- Uses Firebase Google Sign-In for authentication
- All authenticated users can write to collections
- PIN protection provides UI-level access control
- Users authenticate with their Google accounts, providing better accountability
- For additional security, consider:
  - Custom claims for role-based access
  - More restrictive Firestore rules based on email domains
  - Allowlist specific Google accounts

### Firestore Rules
Current rules allow any authenticated user to write. For production:
- Consider adding custom claims for teacher/parent roles
- Restrict certain operations to specific roles
- Add validation rules for data integrity

## Maintenance

### Adding New Save Functions
When adding new Firestore write operations:

1. Make the function async
2. Call `await ensureAuthenticated()` before writing
3. Wrap in try/catch for error handling
4. Show user-friendly error messages

Example:
```javascript
async function saveNewFeature() {
  try {
    await ensureAuthenticated();
    await db.collection('classData').doc('current').set(data, { merge: true });
  } catch (error) {
    console.error('Save failed:', error);
    // Show user-friendly error
  }
}
```

## Troubleshooting

### "User not authenticated" Errors
- Ensure user enters edit mode with PIN first
- Check browser console for authentication logs
- Verify Firebase Auth is properly initialized

### Permission Denied Errors
- Check Firestore rules in Firebase Console
- Verify `request.auth != null` rule is present
- Ensure user is signed in (check `auth.currentUser`)

### Authentication Not Persisting
- Google Sign-In sessions persist across page reloads
- Firebase maintains the authentication state
- Users may need to re-authenticate if they clear browser data or after session expires
