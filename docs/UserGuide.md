# Signara — User Guide

Signara is the place where your documents get signed — securely, with a
complete audit trail, and without anyone else owning the process.

## 1. Getting started

1. Your administrator sends you an invitation, or your organization is
   pre-provisioned (Authentik SSO).
2. Click **Sign in** on `app.signara.innotel.us` — you land on the Authentik
   login (use your organization credentials; MFA if enabled).
3. You land on the **Dashboard** showing your documents and activity.

> New to an organization? Ask your administrator to assign you a role
> (Member, Manager, Auditor, Administrator). Your default role is Member.

## 2. Uploading documents

1. **Documents → Upload** or the **Upload document** button on the dashboard.
2. Choose a PDF, DOCX, PNG, JPEG, or WebP (max 50 MB).
3. The document appears in your list. It is stored encrypted at rest in your
   own storage (MinIO), versioned, and checksummed.

Supported actions per document (depends on your role):

| Action | Who |
| --- | --- |
| Download original / versions | Anyone with document access |
| View version history | Members+ (with `documents.versions`) |
| Send for signature | Members+ (`signing.send`) |
| Update metadata / tags | Members+ |
| Delete (soft) | Members+ (`documents.delete`) |
| Audit / evidence | Auditors and above |

## 3. Sending a document for signature

1. Open the document → **Send for signature**.
2. Add recipients:
   - **Signer** — must sign;
   - **Approver** — approves before/alongside signing (add `workflowRules`
     for conditional approval routing);
   - **CC** — receives a copy, cannot sign.
3. Choose the order:
   - **Sequential** — each signer signs in turn (recommended for contracts);
   - **Parallel** — everyone can sign at once.
4. Optional: add a message and a deadline.
5. **Send** — each recipient receives an email with a secure link.

## 4. Signing a document

1. Open the link from the email (it looks like
   `https://app.signara.innotel.us/sign/sgn_...`).
2. Review the document, the sender&apos;s message, and the deadline.
3. Choose a signature type (typed or drawn) — or, for certificate-backed
   flows, sign with your certificate.
4. **Sign document** — your signature, timestamp, IP address, and browser are
   recorded in the audit trail.
5. You can also **decline** with a reason; in sequential flows a decline pauses
   the request.

> The link is personal and secret — don&apos;t forward it. Requests expire after
> the deadline.

## 5. Templates

Instead of re-adding the same fields, save a template:

1. **Templates → Create** (from an uploaded document).
2. Place **fields** (signature, initials, date, text, checkbox, dropdown,
   names/emails, custom) on the document pages.
3. Define **variables** to inject dynamic values (`{{company_name}}`).
4. When you send for signature from a template, recipients fill the fields and
   the data is applied automatically.

## 6. Notifications

- In-app notifications appear in the bell menu (email/SMS also flow when the
  administrator enables them).
- **Reminders**: senders can remind pending signers — no more than once per
  signer per 24 hours.
- Escalation: administrators can configure escalation steps in
  [AdministrationGuide.md](AdministrationGuide.md#escalations).

## 7. Audit trail & evidence

Every signing request keeps an evidence report:

- envelope summary (signers, roles, statuses, timestamps)
- complete event trail (created, viewed, signed, declined, reminded, expired…)
  with IP addresses and user agents
- per-signature hash (`SHA-256` over the document + signer identity)
- certificate serials for certificate-backed signatures
- a plain-language compliance statement

Senders and Auditors can download this report for record-keeping.

## 8. Team & members

**Settings → Team** lists everyone in your organization. If you are an owner or
an administrator you can also manage them there:

1. **Add member** — type their email, choose a role (Member, Manager, Auditor,
   Administrator) and press **Add member**. An email that already has an account
   is linked to the organization immediately; otherwise the account is created as
   `INVITED` and authenticates through Authentik on first sign-in.
2. **Remove** — the button on a member's row takes them out of the organization;
   they lose access to its documents. The organization owner cannot be removed.

Roles decide what a member may do (`members.invite`, `members.manage`,
`signing.send`, and so on); see
[AdministrationGuide.md](AdministrationGuide.md) for the full list.

## 9. FAQ

**Is my signature legally binding?** Electronic signatures are admissible under
eIDAS (EU) and the ESIGN Act (US). Signara records intent, identity data,
timestamps, and an audit trail to support that.

**Can I unsend a request?** Yes — if it isn&apos;t completed, a Manager+ can
cancel it; signers see the session as no longer available.

**What happens at the deadline?** The request expires and is marked `EXPIRED`;
signers can no longer sign. Senders can re-issue a new request.

**Can I sign on my phone?** Yes — the signing room is mobile-first and
responsive.

**Can I try a signing room before creating an account?** Yes — **Try a demo
signing room** (or `/sign/demo`) is a sample request that runs entirely in your
browser. Nothing is sent anywhere; it is a walkthrough of the room, not a real
request.