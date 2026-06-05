# Sandbox image — `kuntik/librechat-skills`

Custom Daytona sandbox image carrying everything the Anthropic
xlsx / docx / pptx / pdf skills need so a LibreChat code-interpreter
session can follow each `SKILL.md` end-to-end without per-call
`pip install` overhead.

## What's inside

- `python:3.12-slim` base
- LibreOffice (calc / writer / impress, no Java/recommends)
- pandoc, poppler-utils, qpdf, tesseract
- Node.js 20 + globals: `docx`, `pptxgenjs`
- pip: `openpyxl`, `python-docx`, `python-pptx`, `pandas`,
  `matplotlib`, `pillow`, `tabulate`, `pypdf`, `pdfplumber`,
  `reportlab`, `pytesseract`, `pdf2image`, `markitdown[pptx]`
- `https://github.com/anthropics/skills` cloned into
  `/opt/anthropic-skills` (pinned via `--build-arg SKILLS_REF=…`)
- Each skill's `scripts/` directory on `PYTHONPATH`

## Build & push

```bash
docker build -t kuntik/librechat-skills:0.2 sandbox-image/
docker push  kuntik/librechat-skills:0.2
```

To pin to a specific skills revision:

```bash
docker build \
  --build-arg SKILLS_REF=<git-sha-or-tag> \
  -t kuntik/librechat-skills:0.2 sandbox-image/
```

Daytona refuses the `latest` tag — always use an explicit version.

## Size

Expect ~1.3–1.5 GB compressed. The sandbox disk must be
`DAYTONA_SANDBOX_DISK >= 3` for this image to fit comfortably; the
1 GiB value shown in the handoff `.env` will not work.

## Wiring the adapter to use it

Set in the adapter `.env`:

```dotenv
DAYTONA_SANDBOX_IMAGE=kuntik/librechat-skills:0.2
DAYTONA_SANDBOX_DISK=3
```

`DAYTONA_SANDBOX_IMAGE` being set also tells the adapter to **skip**
its per-session `pip install` priming — everything is already baked
in, so the ~14 s priming cost goes away. First-call latency on a
warm Daytona worker becomes just the sandbox boot (~5 s); on a cold
worker, add the image pull (~30–60 s for the first sandbox per
worker, then cached).

## Smoke test

```bash
docker run --rm kuntik/librechat-skills:0.2 bash -c '
  set -e
  soffice --version
  pandoc --version | head -1
  tesseract --version 2>&1 | head -1
  node --version
  python -c "import openpyxl, docx, pptx, pypdf, reportlab, pytesseract; print(\"py deps ok\")"
  ls /opt/anthropic-skills/skills/
'
```
