#!/usr/bin/env python3
"""Strip openpyxl's x14 conditional-formatting extensions from an .xlsx.

openpyxl writes data-bar (and some other) conditional formatting twice: a
legacy ``<dataBar>`` plus an ``x14`` extension copy in ``<extLst>``. Excel
cross-validates the two and, when openpyxl's x14 block is incomplete or the
legacy ``cfvo`` is degenerate (``type="min" val="0"``), pops the dreaded
"We found a problem with some content -> Repaired Records: Conditional
formatting" dialog. The legacy data bars render fine on their own, so the
safe fix is to drop only the x14 CF extension and normalize min/max cfvo.

Targeted on purpose:
  * ``{78C0D931-6437-407d-A8EE-F0AAD7539E65}`` -- worksheet-level
    ``x14:conditionalFormattings``.
  * ``{B025F937-C7B1-47D3-B67F-A62EFF666E3E}`` -- the per-cfRule ``x14:id``
    link inside a data-bar rule.
Other extensions (charts, sparklines, x14 data validations, workbook x15)
are left untouched -- some are required for those features to render.

Usage:
    python sanitize_xlsx.py FILE.xlsx [FILE2.xlsx ...]   # fixes in place
Exit code 0 always (no-op on a clean file); prints a JSON summary per file.
"""
import json
import re
import sys
import zipfile
from io import BytesIO

# x14 conditional-formatting extension URIs that trigger Excel's repair prompt.
CF_EXT_URIS = (
    "{78C0D931-6437-407d-A8EE-F0AAD7539E65}",  # worksheet x14:conditionalFormattings
    "{B025F937-C7B1-47D3-B67F-A62EFF666E3E}",  # per-cfRule x14:id link (data bar)
)

# An <ext ... uri="<URI>"> ... </ext> wrapped in its own <extLst>. openpyxl
# always emits one ext per extLst for these, so a non-greedy match is safe.
def _ext_pattern(uri):
    esc = re.escape(uri)
    return re.compile(r'<extLst><ext\b[^>]*uri="' + esc + r'">.*?</ext></extLst>', re.S)


# Degenerate legacy data-bar bounds: type="min"/"max" must not carry a val.
_CFVO_MIN = re.compile(r'<cfvo type="min" val="[^"]*"\s*/?>(?:</cfvo>)?')
_CFVO_MAX = re.compile(r'<cfvo type="max" val="[^"]*"\s*/?>(?:</cfvo>)?')


def sanitize_sheet_xml(xml: str):
    """Return (new_xml, changed) for one worksheet XML string."""
    changed = 0
    for uri in CF_EXT_URIS:
        xml, n = _ext_pattern(uri).subn("", xml)
        changed += n
    xml, n = _CFVO_MIN.subn('<cfvo type="min"/>', xml)
    changed += n
    xml, n = _CFVO_MAX.subn('<cfvo type="max"/>', xml)
    changed += n
    return xml, changed


def sanitize_file(path: str) -> dict:
    with zipfile.ZipFile(path, "r") as zin:
        infos = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in infos}

    total = 0
    touched = []
    for name in list(contents):
        if not (name.startswith("xl/worksheets/") and name.endswith(".xml")):
            continue
        xml = contents[name].decode("utf-8")
        new_xml, changed = sanitize_sheet_xml(xml)
        if changed:
            contents[name] = new_xml.encode("utf-8")
            total += changed
            touched.append(name)

    if total == 0:
        return {"file": path, "status": "clean", "changes": 0}

    # Repack preserving member order, names, timestamps, and attributes.
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in infos:
            zi = zipfile.ZipInfo(i.filename, date_time=i.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = i.external_attr
            zout.writestr(zi, contents[i.filename])
    with open(path, "wb") as f:
        f.write(buf.getvalue())

    return {"file": path, "status": "sanitized", "changes": total, "sheets": touched}


def main(argv):
    if not argv:
        print("usage: sanitize_xlsx.py FILE.xlsx [...]", file=sys.stderr)
        return 2
    for path in argv:
        try:
            print(json.dumps(sanitize_file(path)))
        except Exception as e:  # noqa: BLE001 -- report, never hard-fail a QA step
            print(json.dumps({"file": path, "status": "error", "error": str(e)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
