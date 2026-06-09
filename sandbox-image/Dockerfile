# Sandbox image for the Daytona-backed LibreChat code interpreter.
#
# Carries everything the Anthropic xlsx / docx / pptx / pdf skills need so
# the agent can follow each SKILL.md end-to-end (including the LibreOffice
# recalc / PDF-conversion steps) without per-session pip installs.
#
# Built and pushed manually:
#   docker build -t kuntik/librechat-skills:1.1 sandbox-image/
#   docker push  kuntik/librechat-skills:1.1
#
# Daytona requires an explicit tag — never use :latest.
#
# 0.3: bake sanitize_xlsx.py (strips openpyxl's x14 conditional-formatting
#      extension that makes Excel demand "Repair" on data-bar workbooks).
# 0.4: bake the slides toolkit at /opt/skill-tools/slides — pptxgenjs builder +
#      in-memory geometry linter (deck_helpers.js), render/contact-sheet
#      helpers, and OpenAI deck-profile design guidance. See PROVENANCE.md.
# 0.5: bake metric-compatible fonts (Carlito≈Calibri, Gelasio≈Georgia) + a
#      fontconfig alias so LibreOffice renders the deck type pair faithfully;
#      add check_overlaps.py — a render-based (pdfplumber) geometry gate that
#      catches wrapped-title collisions the in-memory lint misses.
# 0.6: check_overlaps.py also flags text spilling into a card (panel-intrusion);
#      column-aware line clustering so multi-card rows aren't false-positives.
# 0.7: fix line clustering to require true horizontal adjacency (symmetric gap),
#      so far-apart text on a shared baseline no longer merges into one wide
#      line that falsely "spills" across cards.
# 0.8: add diagram primitives to deck_helpers (box/node/connector/flow) so decks
#      stop hand-rolling raw addShape (the recurring crash source) — valid
#      ShapeTypes only, auto-contrast text, geometry/edge anchors returned.
# 0.9: box/node accept the options-object form (box(deck,s,{x,y,w,h,text,fill}))
#      + text/size aliases — the form models actually call (0.8 was positional-
#      only, so boxes collapsed to a stray default box). Plus image helpers
#      (pickImage/guardImages/listImages) for content-matched asset selection.
# 1.0: card/kpi/pill also accept the options-object form — pill was still
#      positional, so pill(deck,s,{text,…}) rendered a literal "undefined" + a
#      stray box. All geometric helpers now take {x,y,…} uniformly.
# 1.1: add `unzip` (zip-attached asset bundles failed with "unzip: command not
#      found"). deck_helpers gains ensureAssets()/assertAssets(): the build
#      script fetches its OWN external images in the same exec that renders
#      (every run_code is an isolated, ephemeral sandbox — assets cloned in a
#      prior call are gone), and hard-fails instead of silently shipping a deck
#      with blank holes where product images belong.

FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NODE_MAJOR=20 \
    LIBREOFFICE_USER_PROFILE=/tmp/lo-profile \
    HOME=/root

# System tooling: LibreOffice (calc/writer/impress) for the recalc + PDF
# conversion the skills rely on; pandoc for docx text extraction; poppler &
# qpdf & tesseract for the pdf skill; node for the docx/pptx skills' npm
# globals; fonts so rendered output isn't tofu.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-core libreoffice-calc libreoffice-writer libreoffice-impress \
        libreoffice-common \
        pandoc \
        poppler-utils qpdf \
        tesseract-ocr tesseract-ocr-eng \
        fonts-dejavu fonts-liberation fonts-noto-core fonts-crosextra-carlito \
        git curl ca-certificates gnupg unzip \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Gelasio = Georgia-metric serif (OFL, Google Fonts). Pairs with Carlito
# (Calibri-metric, apt above) so the deck_helpers Georgia/Calibri type pair
# renders faithfully — measured wrapping then matches what PowerPoint shows.
# local.conf aliases Georgia->Gelasio / Calibri->Carlito for LibreOffice.
RUN mkdir -p /usr/share/fonts/truetype/gelasio \
    && curl -fsSL -o /usr/share/fonts/truetype/gelasio/Gelasio.ttf \
         "https://raw.githubusercontent.com/google/fonts/main/ofl/gelasio/Gelasio%5Bwght%5D.ttf" \
    && curl -fsSL -o /usr/share/fonts/truetype/gelasio/Gelasio-Italic.ttf \
         "https://raw.githubusercontent.com/google/fonts/main/ofl/gelasio/Gelasio-Italic%5Bwght%5D.ttf" \
    && curl -fsSL -o /usr/share/fonts/truetype/gelasio/OFL.txt \
         "https://raw.githubusercontent.com/google/fonts/main/ofl/gelasio/OFL.txt"
COPY fonts/local.conf /etc/fonts/conf.d/99-deck-fonts.conf
RUN fc-cache -f >/dev/null

# Python deps spanning all four skills + the artifact-rendering libs the
# 0.8.6 LibreChat agent already expects.
RUN pip install --no-cache-dir \
        openpyxl \
        python-docx \
        python-pptx \
        pandas matplotlib pillow tabulate \
        pypdf pdfplumber reportlab \
        pytesseract pdf2image \
        "markitdown[pptx]"

# Node globals used by docx/pptx skills.
RUN npm install -g docx pptxgenjs

# So scripts written by the model into /mnt/data or /tmp/workspace can
# `require('pptxgenjs')` / `require('docx')` without each script having to
# install them locally. Node doesn't auto-resolve globals from arbitrary
# script locations — NODE_PATH must point at the global node_modules dir.
ENV NODE_PATH=/usr/lib/node_modules

# Clone Anthropic's skills at a pinned commit. Bump the SHA below to update.
ARG SKILLS_REF=main
RUN git clone --depth 1 --branch "${SKILLS_REF}" \
        https://github.com/anthropics/skills /opt/anthropic-skills \
    && rm -rf /opt/anthropic-skills/.git

# Put each skill's scripts dir on PYTHONPATH so the model can
# `from soffice import get_soffice_env` etc. without hardcoding paths.
ENV PYTHONPATH=/opt/anthropic-skills/skills/xlsx/scripts:/opt/anthropic-skills/skills/docx/scripts:/opt/anthropic-skills/skills/pptx/scripts:/opt/anthropic-skills/skills/pdf/scripts:${PYTHONPATH}

# xlsx post-processor: strips openpyxl's repair-triggering x14 conditional-
# formatting extension. On PATH and PYTHONPATH so the model can either run
# `sanitize_xlsx.py out.xlsx` or `from sanitize_xlsx import sanitize_file`.
COPY sanitize_xlsx.py /opt/skill-tools/sanitize_xlsx.py
RUN chmod 0755 /opt/skill-tools/sanitize_xlsx.py \
    && ln -s /opt/skill-tools/sanitize_xlsx.py /usr/local/bin/sanitize_xlsx
ENV PYTHONPATH=/opt/skill-tools:${PYTHONPATH}

# Slides toolkit: pptxgenjs builder + in-memory geometry linter
# (deck_helpers.js), render + contact-sheet helpers, and OpenAI deck-profile
# design guidance. `require("/opt/skill-tools/slides/deck_helpers.js")` resolves
# pptxgenjs via NODE_PATH above. See /opt/skill-tools/slides/PROVENANCE.md.
COPY slides /opt/skill-tools/slides
RUN chmod 0755 /opt/skill-tools/slides/*.sh
ENV PATH=/opt/skill-tools/slides:${PATH}

# LibreOffice needs a writable profile dir even in headless mode. The
# skills' office/soffice.py wrapper expects this to be settable.
RUN mkdir -p /tmp/lo-profile /tmp/workspace && chmod 0777 /tmp/lo-profile /tmp/workspace

WORKDIR /tmp/workspace
