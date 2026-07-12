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

Carrier email-to-text gateways are not reliable enough for this site. AT&T gateway addresses such as `mms.att.net` and `txt.att.net` can bounce before a text is ever sent.

For real text messages, the Firebase Function can send SMS through Twilio when these GitHub repository secrets are set:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

By default, texts go to `+18164821708`. To change or add recipients without editing code, set `TEACHER_NOTIFICATION_PHONE_NUMBERS` to a comma-separated list of phone numbers in `+1XXXXXXXXXX` format.

The old `TEACHER_NOTIFICATION_SMS_EMAILS` gateway setting is ignored unless `ENABLE_EMAIL_TO_SMS_GATEWAYS` is set to `true`.
