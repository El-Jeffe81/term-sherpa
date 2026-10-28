# Risk Taxonomy

The categories of "gotchas" an entry can contain. Each gotcha in an entry uses one `risk_category` id from this list, a severity, and the **default state** (what happens if the reader does nothing).

> Information, not legal advice. Ratings are editorial judgments about a reader's exposure, based on the public text at the captured date.

## Severity rubric (applies to every category)

| Severity | Meaning |
|----------|---------|
| **high** | On by default (or unavoidable), affects sensitive or personal content, and hard to reverse or opt out of. |
| **medium** | Meaningful effect on privacy or money, but opt-out is available or the effect is limited. |
| **low** | Minor, clearly disclosed, easy to avoid or reverse. |
| **info** | Worth knowing, no action needed. |

Rules of thumb: raise the severity one step if the default is "on", if opting out takes many steps, or if it covers sensitive content (health, children, work documents). Lower it one step if the setting is off by default and clearly explained. Record the reasoning in the gotcha's explanation.

## Categories

The first five are the **core entries** every AI-service page must address (even if the answer is "not found in the public text").

### 1. `retention`: how long the service keeps your data
- **Look for:** stated retention periods; whether deleted chats are really deleted or kept for a time; backups; "as long as necessary" wording; a separate period for safety review.
- **Severity:** high if retention is indefinite or unstated and cannot be shortened; medium if long but controllable; low if short and clearly stated.

### 2. `data_sharing_sale`: whether it sells or shares your data
- **Look for:** "sell", "share", "disclose" with partners, affiliates, advertisers or data brokers; "service providers"; sharing for advertising; sharing in a sale of the company.
- **Severity:** high if sale or ad-sharing is on by default; medium if sharing with named categories of partners and an opt-out exists; low if limited to service providers needed to run the service.

### 3. `training_on_data`: whether it can use your content for AI training
- **Look for:** whether prompts, files, voice or images may be used to improve or train models; whether it is on by default; per-product differences (consumer vs. business plans); a toggle or form to opt out; whether human reviewers can read chats.
- **Severity:** high if on by default with no opt-out; medium if on by default with a working opt-out; low if off by default or opt-in.

### 4. `arbitration_class_waiver`: forced arbitration with no class actions
- **Look for:** "binding arbitration", "waive", "class action", "jury trial"; opt-out window and how to use it (often a short deadline); small-claims exceptions.
- **Severity:** high if mandatory with no opt-out; medium if mandatory with a clear opt-out window; low if absent.

### 5. `unilateral_changes`: whether it can change its terms without notice
- **Look for:** "we may modify these terms at any time"; whether notice is given (email, in-app) or the reader must check back; continued use counting as acceptance.
- **Severity:** high if changes can take effect without notice; medium if notice is given only by posting on the site; low if direct notice with time to object.

### 6. `auto_renewal`
- **Look for:** free trials that convert to paid, renewal periods, cancellation method and deadline, price-change clauses, refund terms.
- **Severity:** high if renewal is automatic and cancellation is hard or non-refundable; medium if automatic with simple cancellation; low if clearly flagged and easy.

### 7. `content_license`
- **Look for:** a license you grant on your inputs or outputs (scope, worldwide, sublicensable, perpetual); who owns outputs; use of your name or likeness; whether the license ends when you delete content.
- **Severity:** high if broad, perpetual and surviving deletion; medium if broad but limited to running the service; low if narrow.

### 8. `location_contacts_access`
- **Look for:** location (precise vs. approximate), contacts, photos, microphone, camera, and device identifiers; whether permission is requested at install or by default; whether it works without them.
- **Severity:** high if precise location or contacts are collected by default; medium if requested but optional; low if not collected.

### 9. `account_deletion`
- **Look for:** whether you can delete the account in-app or only by email; waiting periods; what data survives deletion; whether deleting is the same as deactivating.
- **Severity:** high if no real deletion path or data survives indefinitely; medium if deletion exists but is slow or partial; low if simple and complete.

## How categories map to entries

Each gotcha in a service entry has `risk_category` (one of the ids above), `severity`, `default_state`, a plain `explanation`, `fix_steps`, and `source_refs` pointing to the captured text. See [data-model.md](data-model.md).

Adding a category later is a schema change (new id in the enum), done in its own PR.
