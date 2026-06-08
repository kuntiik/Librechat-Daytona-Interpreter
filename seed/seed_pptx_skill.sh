#!/usr/bin/env bash
# Update the LibreChat `pptx` skill body in Mongo from pptx-skill-body.md.
#
# Backs up the current doc, then sets the new body, bumps version, and clears
# fileCount (the old body referenced editing.md/pptxgenjs.md reference files
# that 404 on prime; the new body points at /opt/skill-tools/slides/ instead).
#
#   ./seed_pptx_skill.sh                       # uses default local URI
#   MONGO_URI=mongodb://host/LibreChat ./seed_pptx_skill.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BODY_FILE="$HERE/pptx-skill-body.md"
URI="${MONGO_URI:-mongodb://127.0.0.1:27017/LibreChat}"
[ -f "$BODY_FILE" ] || { echo "missing $BODY_FILE" >&2; exit 1; }

echo "Backing up current pptx skill -> $HERE/pptx-skill.backup.$(date +%s).json"
mongosh --quiet "$URI" --eval 'printjson(db.skills.findOne({name:"pptx"}))' \
  > "$HERE/pptx-skill.backup.$(date +%s).json"

BODY_B64="$(base64 < "$BODY_FILE" | tr -d '\n')"

mongosh --quiet "$URI" --eval "
const body = Buffer.from('$BODY_B64', 'base64').toString('utf8');
const r = db.skills.updateOne(
  { name: 'pptx' },
  { \$set: { body, fileCount: 0, updatedAt: new Date() }, \$inc: { version: 1 } }
);
printjson(r);
print('pptx skill body bytes: ' + body.length);
"
echo "Done. Re-open the agent builder and confirm the pptx skill is enabled."
