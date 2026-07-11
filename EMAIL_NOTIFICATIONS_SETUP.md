# Teacher email notifications

This site records parent activity in Firestore. The Firebase Function in `functions/index.js` watches the `teacherActivity` collection and creates safe email request documents in a `mail` collection.

That `mail` collection is meant to be sent by Firebase's official **Trigger Email from Firestore** extension.

## What to set up in Firebase

1. Open Firebase Console for this project.
2. Install the official **Trigger Email from Firestore** extension.
3. When Firebase asks for the email documents collection, use:

   ```text
   mail
   ```

4. Enter the SMTP details from the email sender you want to use, such as SendGrid, Mailgun, or another SMTP provider.
5. Set a default FROM address for the emails. A simple option is something like:

   ```text
   First Grade Hub <no-reply@your-sender-domain.org>
   ```

6. Deploy Firebase Functions after this PR is merged so the `teacherActivity` watcher is live.

## What will send an email

An email is queued when a parent creates one of these activity records:

- snack signup
- student shoutout
- volunteer signup
- transportation update

Daily visitor totals are saved for the teacher dashboard, but they do not send an email each time someone opens the site.

## Recipients

By default, emails go to:

```text
dgonzalezjr@crossroadsschoolskc.org
lvest@crossroadsschoolskc.org
```

If this ever needs to change without editing code, set the Firebase Functions environment variable `TEACHER_NOTIFICATION_EMAILS` to a comma-separated list of addresses. The older single-address variable `TEACHER_NOTIFICATION_EMAIL` is still supported.

## Text notifications

The same email pipeline can also send text-message notifications through carrier email-to-SMS gateways. Set `TEACHER_NOTIFICATION_SMS_EMAILS` to a comma-separated list of gateway addresses, such as `5551234567@vtext.com`.

SMS gateway delivery depends on the phone carrier and is less reliable than regular email. For more dependable texting, use a dedicated SMS provider such as Twilio instead of the Firebase email extension.
