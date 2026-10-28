# Data Model

Each service has **one entry**: a single JSON file validated by [`schema/service.schema.json`](../schema/service.schema.json) (JSON Schema draft 2020-12). The static site is built from these files. A fictional sample is in [`examples/sample-service.json`](../examples/sample-service.json).

> Information, not legal advice. See [legal-and-safety.md](legal-and-safety.md).

## Fields

| Field | Required | What it holds |
|-------|----------|---------------|
| `schema_version` | yes | Version of this schema, e.g. `"1.0"`. |
| `example` | no | `true` only on fictional samples. Never publish these as real. |
| `service` | yes | Service name. |
| `category` | yes | `ai-chatbot`, `ai-assistant`, `ai-image`, `ai-other`, `app-store-app`, `other`. |
| `sources` | yes | Public pages the entry is based on. See below. |
| `last_verified` | yes | Date a person last confirmed the entry against the sources. |
| `agreements` | yes | "What you agree to": plain-language summaries, each with `source_refs`. |
| `optional_items` | yes | "What you can refuse": summary plus `how_to_refuse`. |
| `gotchas` | yes | Things that happen by default. See below. |
| `recommended_setup` | yes | Ordered, privacy-first steps. |
| `change_log` | yes | Dated record of edits, with old and new hashes when terms changed. |
| `disclaimer` | yes | The disclaimer text shown on the page. |

### `sources`: URL, capture date, content hash

Every source records:

| Field | Meaning |
|-------|---------|
| `id` | Short id (e.g. `terms`, `privacy`) used by findings to point back to this source. |
| `type` | `terms`, `privacy-policy`, `settings-help`, `other`. |
| `url` | The public `https://` page. |
| `retrieved` | The date the page text was **captured**. |
| `content_hash` | **SHA-256** (lowercase hex, 64 chars) of the **normalized** page text as captured. |
| `hash_algorithm` | Always `sha256` for now. |
| `normalization` | Version tag of the normalization recipe (e.g. `v1`). |

**Normalization (recipe v1, to be finalized):** take the visible text of the page's main content, drop navigation, scripts and styling, convert to Unicode NFC, collapse all whitespace to single spaces, trim. Hash the UTF-8 bytes. Keeping the recipe fixed and versioned means the same text always gives the same hash.

**How the hash detects changes.** The re-check job fetches each source, normalizes it with the same recipe, and hashes it. If the new hash equals `content_hash`, the text is unchanged and only `last_verified` moves forward. If it differs, the terms changed (or the page layout did, which a person will rule out in review), so the entry is flagged for review. After review, the `change_log` gets a line with `old_hash` and `new_hash`, and `sources[].content_hash` and `retrieved` are updated. If the recipe itself changes, bump `normalization` and re-baseline the hashes so a recipe change is not mistaken for a terms change.

**How every finding traces back to its text.** Each agreement, optional item and gotcha carries `source_refs`. A reference is:

- `source_id`: which source (so you get the URL, capture date and hash),
- `locator`: the section heading or paragraph number in the captured text,
- `excerpt` (optional): a **short** quote, 200 characters max.

So a reader or reviewer can go from any claim to the source URL, the exact version of the text (identified by date and hash), and the place in it. The captured text itself is kept privately for review and is **not** republished (see the excerpt policy in [legal-and-safety.md](legal-and-safety.md)). Because the hash identifies the exact text, a claim can be re-checked later even after the live page changes.

### `gotchas`

| Field | Meaning |
|-------|---------|
| `id` | Short unique id within the entry. |
| `risk_category` | One id from [risk-taxonomy.md](risk-taxonomy.md): `retention`, `data_sharing_sale`, `training_on_data`, `arbitration_class_waiver`, `unilateral_changes`, `auto_renewal`, `content_license`, `location_contacts_access`, `account_deletion`. |
| `title` | Short plain title. |
| `severity` | `high`, `medium`, `low`, `info`, per the rubric. |
| `default_state` | `on`, `off`, `unavoidable`, `not_stated`: what happens if the reader does nothing. |
| `explanation` | Plain-English explanation. |
| `fix_steps` | Ordered steps to change it. Empty only when nothing can be changed. |
| `source_refs` | Trace to the captured text (at least one). |

Core entries: every AI-service page should address retention, data sharing or sale, training on your data, arbitration and class-action waiver, and unilateral changes to terms, even if the answer is `not_stated`.

## Validating an entry

```bash
python3 -m venv .venv && .venv/bin/pip install jsonschema
.venv/bin/python - <<'PY'
import json
from jsonschema import Draft202012Validator, FormatChecker
schema = json.load(open("schema/service.schema.json"))
entry = json.load(open("examples/sample-service.json"))
Draft202012Validator.check_schema(schema)
errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(entry))
print("VALID" if not errors else errors)
PY
```

`npx ajv-cli` with `--spec=draft2020` works too. A CI check for this is a good first follow-up (see [roadmap.md](roadmap.md)).
