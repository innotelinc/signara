# OpenSign parity reference

**Status:** harvest record — 2026-09-20
**Owner:** Innotel
**Source:** `innotelinc/sign`, the retired OpenSign fork (`apps/OpenSign`,
`apps/OpenSignServer`), harvested the day before that repository was frozen.
**Companions:** [Roadmap.md](Roadmap.md) §W2 owns the parity rows and their issue
numbers; `sign/ARCHIVE.md` in this estate records what was carried out of the fork
and what was deliberately left behind.

Parity rows in the roadmap say things like "verify the field-placement editor
covers every OpenSign field type" or "confirm the certificate layout matches what
signers were shown". Since the fork is being frozen read-only, the things those
rows have to be measured against are written down here instead of looked up in the
archived tree.

**What this is not.** It is not a code port. The fork's signing implementation
(Parse `signPdf`, PFX handling, `/ByteRange` work) is deliberately _not_ carried
over — Signara has its own `certificates` module and signing path, and a second
implementation of PDF signing is a liability rather than an asset
(`sign/ARCHIVE.md` §1). These are the **user-visible** strings, field vocabulary
and document layout that "parity" is measured against, so the question "did we lose
a capability a user still expects?" has an answer that does not require an
archived fork.

---

## 1. Field vocabulary — issue #81

The field types the old product offered a sender, from the harvested English
catalog's `widgets-name` group (now shipped in
`apps/web/public/locales/en/translation.json`, keyed as OpenSign keyed it):

| Catalog key  | Label as shown |     | Catalog key    | Label as shown |
| ------------ | -------------- | --- | -------------- | -------------- |
| `signature`  | signature      |     | `cells`        | cells          |
| `stamp`      | stamp          |     | `checkbox`     | checkbox       |
| `initials`   | initials       |     | `dropdown`     | dropdown       |
| `name`       | name           |     | `radio button` | radio button   |
| `job title`  | job title      |     | `image`        | image          |
| `company`    | company        |     | `email`        | email          |
| `date`       | date           |     | `number`       | number         |
| `text`       | text           |     | `draw`         | draw           |
| `text input` | text input     |     | `attachments`  | attachments    |

`attachments-add` ("Click to add attachments") and `attachments-count`
("`{{count}}` attachment(s)") sit in the same group but are attachments UI, not
field types. OpenSign's own marketing string claims **"14 field types"**
(`benefit-14-field-types`) while the catalog groups **18** — an inconsistency in
the source, not here; the catalog group is the behaviour to match.

**The vocabulary is the smaller half of this row.** The editor's behaviour is
described by strings that assume features, so #81 is only satisfied if each of
these exists:

| Behaviour                                                                                     | OpenSign's string                                                                                                          |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Detect form fields already in an uploaded PDF (AcroForm) and offer to insert matching widgets | "We detected `{{count}}` form field(s) in the uploaded PDF. Would you like to automatically insert corresponding widgets?" |
| Conditional visibility                                                                        | "This widget is hidden due to conditional logic."                                                                          |
| Prefill values                                                                                | "Prefill Widgets"                                                                                                          |
| Cross-field formulas (number widgets of the same signer)                                      | "No other number widgets are assigned to this signer yet."                                                                 |
| One name per signer                                                                           | "This widget name is already assigned to another signer. Please choose a different name."                                  |
| Value validation for bulk/CSV fills, naming the row                                           | "Invalid value detected in row `{{row}}` for widget `{{widget}}`."                                                         |
| A field with no name yet                                                                      | "Unnamed Signature Field"                                                                                                  |
| Required fields                                                                               | "Please fill out this field"                                                                                               |

### Where #81 landed (2026-09-21)

The vocabulary mapped onto `FieldType`, and the row closed as far as a placement can
be carried — from the editor, through the request, to the signer and into the
evidence. Re-measured against the shipped code rather than the plan:

| OpenSign catalog type | `FieldType`  | Reaches a signer                         |
| --------------------- | ------------ | ---------------------------------------- |
| `signature`           | `SIGNATURE`  | yes                                      |
| `initials`            | `INITIAL`    | yes                                      |
| `name`                | `NAME`       | yes                                      |
| `job title`           | `JOB_TITLE`  | yes                                      |
| `company`             | `COMPANY`    | yes                                      |
| `date`                | `DATE`       | yes                                      |
| `text`                | `TEXT`       | yes                                      |
| `text input`          | `TEXT`       | yes (mapped to the same type)            |
| `checkbox`            | `CHECKBOX`   | yes                                      |
| `dropdown`            | `DROPDOWN`   | yes                                      |
| `email`               | `EMAIL`      | yes                                      |
| `attachments`         | `ATTACHMENT` | **no** — placeable, refused at send time |
| `cells`               | —            | no — not placeable                       |
| `stamp`               | —            | no — not placeable                       |
| `radio button`        | —            | no — not placeable                       |
| `image`               | —            | no — not placeable                       |
| `number`              | —            | no — not placeable                       |
| `draw`                | —            | no — not placeable                       |

**11 of 18 reach a signer, 1 is placeable but refused, 6 cannot be placed.** A
`PHONE`, `ADDRESS` and `CUSTOM` type exist in Signara that the fork did not have.

Attachments are the deliberate exception and are refused by the API at send time
with that reason, rather than handed to a signer as a required field they can
never satisfy. Collecting an uploaded file into a request needs retention,
scanning and access control of its own; recording a file _name_ would put a claim
in the evidence the bytes do not support.

Of the eight behaviours the strings imply, **two exist**: required fields are
enforced in the signing room _and_ in the API (a signature is refused while a
required placement is blank), and an unnamed placement is named after its type.
The other six — AcroForm detection on upload, conditional visibility, prefill,
cross-field formulas, the duplicate-name warning, and CSV/bulk value validation —
are **not implemented**. Five of them — AcroForm detection, conditional
visibility, prefill, cross-field formulas, and the duplicate-name warning — are
editor work, and the sixth, CSV/bulk value validation, belongs with bulk send
(#86, itself an open decision). One is partly structural rather than missing: a
placement is bound to exactly one signer by construction, so a name cannot end up
shared between signers — but the editor does not warn about a duplicate name at
authoring time either.

## 2. Mail identity — issue #83

What the old platform shipped as its defaults, verbatim, with the placeholders it
supported (`{{sender_name}}`, `{{receiver_name}}`, `{{document_title}}`,
`{{signing_url}}`). Source: `constant/Utils.js` (`defaultMailSubject`,
`defaultMailBody`) and the preferences editor that seeded a tenant's own copy.

**Request — send for signature**

```
subject: {{sender_name}} has requested you to sign {{document_title}}
```

```
<p>Hi {{receiver_name}},</p><br><p>We hope this email finds you well. {{sender_name}}&nbsp;has requested you to review and sign&nbsp;{{document_title}}.</p><p>Your signature is crucial to proceed with the next steps as it signifies your agreement and authorization.</p><br><p><a href='{{signing_url}}' rel='noopener noreferrer' target='_blank'>Sign here</a></p><br><br><p>If you have any questions or need further clarification regarding the document or the signing process, please contact the sender.</p><br><p>Thanks</p><p> Team <appName></p><br>
```

**Completion — everyone has signed**

```
subject: Document {{document_title}} has been signed by all parties
```

```
<p>Hi {{sender_name}},</p><br><p>All parties have successfully signed the document {{document_title}}. Kindly download the document from the attachment.</p><br><p>Thanks</p><p> Team <appName></p><br>
```

`<appName>` is the platform name the deployment was branded with — `APP_NAME` for
mail and certificates, `REACT_APP_APPNAME` for the UI, both reading _"Signara by
Innotel"_ by the time this stack was retired, so the footer a signer saw was
"Team Signara by Innotel".

**Per-tenant overrides.** `RequestBody` / `RequestSubject` / `CompletionBody` /
`CompletionSubject` were stored on the tenant and used only when a tenant had set
_both_ the body and the subject; otherwise the defaults above applied
(`EmailEditorType` selected the editor the tenant saw, not the wording).

**Every other mail, subject verbatim:**

| Trigger                                        | Subject                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| A signer has signed; the document is forwarded | `` `${senderName} has signed the doc - ${docName}` ``              |
| Decline                                        | `` `Document "${pdfName}" has been declined by ${signerName}` ``   |
| One-time passcode                              | `` `Your ${AppName} OTP` ``                                        |
| Bulk send result                               | `` `Bulk send finished: ${failed} of ${total} failed to create` `` |
| Account deletion request                       | `` `Account Deletion Request for ${username} – ${app}` ``          |

**What Signara sends today, for comparison** (`apps/api/src/modules/mailer/`):
invite `Please sign: <title>`, reminder `Reminder: <title>`, notification subject =
the notification's title, footer identity "Signara · Secure Every Signature", no
completion mail as such and no per-tenant subject/body override. So #83 is a
wording **and** override gap, not only a sender-address question.

The sending identity is the part that costs something if it changes: completion and
request mail went out under the deployment's SMTP/`MAILGUN_SENDER` identity, and
roadmap §W5 keeps that stable so deliverability does not regress.

## 3. Certificate of completion — issue #84

The page the old platform generated as a PDF (`apps/OpenSignServer/cloud/parsefunction/pdf/GenerateCertificate.js`),
in draw order, labels verbatim:

**Page 1**

- top right: `Generated On <timestamp>`; logo top left; a 1px border on every page
- title: **Certificate of Completion**
- `Summary`
  - `Document Id :`, `Document Name :`, `Document hash (sha256) :` (drawn only
    when the document has a hash), `Organization :`, `Created on :`, `Completed on :`
  - `Signers :` and the signer count
- `Document originator`: `Name :`, `Email :`, `IP address :`

**One block per signer**, continued onto a new page when it would overflow the
border:

- heading `1. Signer`, `2. Signer`, … in document order (sorted by signed-on time)
- `Name :`, `Security level :` (drawn as `Email, OTP Auth` when the signer used a
  one-time passcode), `Email :`, `Viewed on :`, `Signed on :`, `IP address :`
- `Signature :` and the signer's signature image, falling back to a placeholder
  when the block has none

Typography, for a faithful redraw: embedded Times (`font/times.ttf`), title 25pt
dark blue, section headings 16pt, body 13pt, timestamps 11pt.

Two things worth carrying explicitly:

- the **`Document hash (sha256)` line is the tamper-evidence anchor** — Signara
  keeps the same idea as `DocumentVersion.checksumSha256`, so the values are
  comparable across the two platforms even though the documents are not (§W4).
- the **per-signer evidence** is what a reader of the old certificate saw: name,
  security level (email alone vs email + OTP), email, viewed-on, signed-on, IP,
  signature image. A Signara evidence rendering that omits any of those is a
  visible regression for anyone comparing the two.

## 4. Carried, and not carried

| Asset                                                    | Verdict                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| UI translations, 7 locales                               | **Carried** — `apps/web/public/locales/`, byte-identical, provenance in that directory's README                                     |
| Field vocabulary, mail strings, certificate layout       | **Carried as this document**; the vocabulary is now implemented in code (#81, 2026-09-21), the other two are tracked by #83 and #84 |
| Feature inventory of the old product                     | **Carried** as roadmap §W2 and issues #81–#92                                                                                       |
| Data mapping and storage reasoning                       | **Retained** in `sign/CONVERGENCE.md` §4–§5 as the historical record                                                                |
| PDF signing implementation (`PDF.js`, PFX, `/ByteRange`) | **Not carried** — `sign/ARCHIVE.md` §1, deliberately                                                                                |
| OpenSign UI and server trees                             | **Not carried** — upstream `opensignlabs/opensign` is canonical                                                                     |
| Deployment config for the retired host                   | **Not carried** — dead with that host (`sign/ARCHIVE.md` §3)                                                                        |

---

_OpenSign is AGPL-3.0, the same license as Signara; attribution and license notice
remain with OpenSignLabs._
