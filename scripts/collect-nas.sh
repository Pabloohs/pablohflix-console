#!/bin/sh
# PabloHFlix Console : inventaire sanitaire local, en lecture seule.
# Écrit UNIQUEMENT des métriques expurgées dans le dossier configuré localement.
# Ne modifie pas les règles iptables, les conteneurs, les volumes, ni SMART.
set -eu
BASE="${PABLOHFLIX_METRICS_DIR:?Définir PABLOHFLIX_METRICS_DIR avec le chemin hôte réel de sortie SMART/Docker}"
umask 022
mkdir -p "$BASE"
TMP="$(mktemp -d "$BASE/.probe.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

# État Docker. Ne copie jamais docker inspect, env, token ou logs.
if command -v docker >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' > "$TMP/docker.psv" 2>/dev/null; then
    chmod 644 "$TMP/docker.psv"
    mv -f "$TMP/docker.psv" "$BASE/docker.psv"
  else
    rm -f "$BASE/docker.psv"
  fi
fi

# Chiffres de capacité des systèmes de fichiers (sans parcourir les fichiers).
if df -Pk /volume1 /volume2 > "$TMP/volumes.df" 2>/dev/null; then
  chmod 644 "$TMP/volumes.df"
  mv -f "$TMP/volumes.df" "$BASE/volumes.df"
else
  rm -f "$BASE/volumes.df"
fi

# SMART horaire seulement, pour éviter de réveiller les disques trop souvent.
NOW=$(date +%s)
LAST=$(cat "$BASE/smart.last" 2>/dev/null || echo 0)
case "$LAST" in ''|*[!0-9]*) LAST=0;; esac
if [ $((NOW - LAST)) -ge 3600 ] && command -v lsblk >/dev/null 2>&1; then
  : > "$TMP/disks.psv"
  lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}' | while IFS= read -r NAME; do
    # zram and other pseudo-devices are not physical SMART disks.
    case "$NAME" in
      zram*|ram[0-9]*|loop[0-9]*|nbd[0-9]*|md[0-9]*|dm-[0-9]*|sr[0-9]*) continue ;;
    esac
    DEV="/dev/$NAME"
    MODEL=$(lsblk -dn -o MODEL "$DEV" 2>/dev/null | tr '|\r\n' '   ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | cut -c1-60)
    SIZE=$(lsblk -dn -o SIZE "$DEV" 2>/dev/null | tr '|\r\n' '   ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | cut -c1-18)
    HEALTH=UNKNOWN
    TEMP=''
    if command -v smartctl >/dev/null 2>&1; then
      OUTPUT=$(smartctl -H "$DEV" 2>/dev/null || true)
      if printf '%s\n' "$OUTPUT" | grep -Eq '(PASSED|OK)'; then HEALTH=PASSED; fi
      if printf '%s\n' "$OUTPUT" | grep -Eq '(FAILED|FAILING)'; then HEALTH=FAILED; fi
      # ATA attribute 194; NVMe reports a standalone "Temperature: N Celsius".
      TEMP=$(smartctl -A "$DEV" 2>/dev/null | awk '
        $1=="194" && $2 ~ /^Temperature/ && $10 ~ /^[0-9]+$/ {print $10;exit}
        $1=="Temperature:" && $2 ~ /^[0-9]+$/ {print $2;exit}
      ' || true)
    fi
    printf '%s|%s|%s|%s|%s\n' "$NAME" "$MODEL" "$SIZE" "$HEALTH" "$TEMP" >> "$TMP/disks.psv"
  done
  chmod 644 "$TMP/disks.psv"
  mv -f "$TMP/disks.psv" "$BASE/disks.psv"
  printf '%s\n' "$NOW" > "$TMP/smart.last"
  chmod 644 "$TMP/smart.last"
  mv -f "$TMP/smart.last" "$BASE/smart.last"
fi

date -Is > "$TMP/updated_at"
chmod 644 "$TMP/updated_at"
mv -f "$TMP/updated_at" "$BASE/updated_at"
