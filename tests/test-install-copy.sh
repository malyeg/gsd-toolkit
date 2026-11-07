#!/usr/bin/env bash
set -euo pipefail
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GSD_NO_CORE=1   # lib/install.sh must not run the real gsd-core installer (npx)

PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
WORK=$(cd "$WORK" && pwd -P)
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
COPY="$WORK/runtime"
SKILLS="$WORK/skills"

install_copy() {
  GSD_BIN_DIR="$BIN" GSD_COPY_DIR="$COPY" GSD_CLAUDE_SKILL_DIR="$SKILLS" \
    "$PKG/lib/install.sh" >/dev/null
}
mkdir -p "$BIN" "$COPY/lib" "$COPY/unrelated-dir"
printf 'local command\n' > "$BIN/gsd-list"
printf 'older backup\n' > "$BIN/gsd-list.bak"
printf 'local library\n' > "$COPY/lib/common.sh"
printf 'keep\n' > "$COPY/unrelated-dir/file"
install_copy
[ -L "$BIN/gsd-list" ]
[ "$(readlink "$BIN/gsd-list")" = "$COPY/bin/gsd-list" ]
[ "$(cat "$BIN/gsd-list.bak")" = 'older backup' ]
[ "$(cat "$BIN/gsd-list.bak.1")" = 'local command' ]
[ "$(cat "$COPY/lib/common.sh.bak")" = 'local library' ]
[ "$(cat "$COPY/unrelated-dir/file")" = keep ]
[ -f "$COPY/shims/scripts/gsd-init.sh" ] || [ -d "$COPY/shims/scripts" ]
[ -f "$COPY/skills/gsdt-flow/SKILL.md" ]
# a skill an older release shipped leaves the runtime on the next copy install
mkdir -p "$COPY/skills/gsd-flow"; printf 'old\n' > "$COPY/skills/gsd-flow/SKILL.md"
install_copy
[ ! -e "$COPY/skills/gsd-flow" ]
# the page checker travels with the runtime: the Node script and the pinned axe-core
[ -f "$COPY/lib/ui-check.mjs" ]
[ -f "$COPY/lib/vendor/axe-core/axe.min.js" ]
[ -f "$COPY/lib/vendor/axe-core/LICENSE" ]
[ -f "$COPY/lib/vendor/axe-core/VERSION" ]
[ -f "$SKILLS/gsdt-flow/SKILL.md" ]

# A skill an older release placed but this one no longer ships (renamed or
# retired) is removed; a skill of the user's own, with no marker, stays.
mkdir -p "$SKILLS/gsd-retired" "$SKILLS/gsd-retired2" "$SKILLS/my-own"
printf 'old\n' > "$SKILLS/gsd-retired/SKILL.md"; printf '0.4.4\n' > "$SKILLS/gsd-retired/.gsd-worktrees-skill"
printf 'old\n<!-- gsd-worktrees-skill 0.5.0 -->\n' > "$SKILLS/gsd-retired2/SKILL.md"
printf 'mine\n' > "$SKILLS/my-own/SKILL.md"
# an older copy, marked by a file of its own, is replaced by one marked in SKILL.md
printf '0.4.4\n' > "$SKILLS/gsdt-flow/.gsd-worktrees-skill"
ln -s "$PKG/skills/gsd-gone" "$SKILLS/gsd-gone"
ln -s "$WORK/elsewhere/skill" "$SKILLS/not-ours"
install_copy
[ ! -e "$SKILLS/gsd-retired" ]
[ ! -e "$SKILLS/gsd-retired2" ]
[ ! -e "$SKILLS/gsdt-flow/.gsd-worktrees-skill" ]
grep -q '^<!-- gsd-toolkit-skill ' "$SKILLS/gsdt-flow/SKILL.md"
[ ! -L "$SKILLS/gsd-gone" ]
[ -f "$SKILLS/my-own/SKILL.md" ]
[ -L "$SKILLS/not-ours" ]
rm -rf "$SKILLS/my-own" "$SKILLS/not-ours"

before=$(find "$WORK" -name '*.bak*' | wc -l | tr -d ' ')
install_copy
after=$(find "$WORK" -name '*.bak*' | wc -l | tr -d ' ')
[ "$before" = "$after" ]

# Before 0.8.0 the package was gsd-worktrees: its skills (gsdw-*, the old
# mark) are retired, and its command links (into share/gsd-worktrees, a
# runtime that may be gone) are replaced in place, not moved to .bak.
for s in gsdw-flow gsdw-worktrees gsdw-tracker; do
  mkdir -p "$SKILLS/$s"; printf 'old\n<!-- gsd-worktrees-skill 0.7.0 -->\n' > "$SKILLS/$s/SKILL.md"
done
OLDRT="$WORK/share/gsd-worktrees/releases/0.7.0"
rm -f "$BIN/gsd-list" "$BIN/gsd-start"
ln -s "$OLDRT/bin/gsd-list" "$BIN/gsd-list"            # dangling: the old runtime is gone
ln -s "$OLDRT/bin/gsd-retired-cmd" "$BIN/gsd-retired-cmd"
mkdir -p "$OLDRT/bin"; printf 'old\n' > "$OLDRT/bin/gsd-start"
ln -s "$OLDRT/bin/gsd-start" "$BIN/gsd-start"          # live: into an old runtime folder
install_copy
for s in gsdw-flow gsdw-worktrees gsdw-tracker; do [ ! -e "$SKILLS/$s" ]; done
[ -f "$SKILLS/gsdt-flow/SKILL.md" ]
[ "$(readlink "$BIN/gsd-list")" = "$COPY/bin/gsd-list" ]
[ "$(readlink "$BIN/gsd-start")" = "$COPY/bin/gsd-start" ]
[ ! -L "$BIN/gsd-retired-cmd" ]
[ -z "$(find "$BIN" -name 'gsd-list.bak.[2-9]*' -o -name 'gsd-start.bak*' -o -name 'gsd-retired-cmd*')" ]
# a current copy marked by an older release is still ours: replaced, no .bak
printf 'old\n<!-- gsd-worktrees-skill 0.7.0 -->\n' > "$SKILLS/gsdt-tracker/SKILL.md"
install_copy
grep -q '^<!-- gsd-toolkit-skill ' "$SKILLS/gsdt-tracker/SKILL.md"
[ ! -e "$SKILLS/gsdt-tracker.bak" ]

# Codex: skills go to ~/.agents/skills; ours left in the old ~/.codex/skills
# (a marked copy, a link of ours, an older name) are removed, a user's stays.
CH="$WORK/codex-home"; mkdir -p "$CH/.codex/skills/gsd-flow" "$CH/.codex/skills/mine"
printf 'old\n' > "$CH/.codex/skills/gsd-flow/SKILL.md"; printf '0.4.4\n' > "$CH/.codex/skills/gsd-flow/.gsd-worktrees-skill"
ln -s "$PKG/skills/gsdt-tracker" "$CH/.codex/skills/gsdt-tracker"
printf 'mine\n' > "$CH/.codex/skills/mine/SKILL.md"
env -u GSD_CODEX_SKILL_DIR -u CODEX_HOME HOME="$CH" GSD_BIN_DIR="$WORK/codex-bin" GSD_COPY_DIR="$WORK/codex-runtime" \
  "$PKG/lib/install.sh" --agent codex --no-user-hook >/dev/null
[ -f "$CH/.agents/skills/gsdt-flow/SKILL.md" ]
[ ! -e "$CH/.codex/skills/gsd-flow" ]
[ ! -L "$CH/.codex/skills/gsdt-tracker" ]
[ -f "$CH/.codex/skills/mine/SKILL.md" ]
# an older release's manifest records ~/.codex/skills: a reinstall from it
# moves the skills too, and a recorded custom dir is kept
CB="$WORK/codex-bin2"; mkdir -p "$CB" "$CH/.codex/skills/gsd-worktrees"
printf 'old\n' > "$CH/.codex/skills/gsd-worktrees/SKILL.md"; printf '0.4.12\n' > "$CH/.codex/skills/gsd-worktrees/.gsd-worktrees-skill"
printf 'providers\tcodex\ncodex_skills\t%s\n' "$(cd "$CH/.codex/skills" && pwd -P)" > "$CB/.gsd-install-manifest"
env -u GSD_CODEX_SKILL_DIR -u CODEX_HOME HOME="$CH" GSD_BIN_DIR="$CB" GSD_COPY_DIR="$WORK/codex-runtime2" \
  "$PKG/lib/install.sh" --reuse-install-config --no-user-hook >/dev/null
[ ! -e "$CH/.codex/skills/gsd-worktrees" ]
grep -q "^codex_skills	$(cd "$CH/.agents/skills" && pwd -P)\$" "$CB/.gsd-install-manifest"
# …also with CODEX_HOME set now: the old default ignored it
CB="$WORK/codex-bin3"; mkdir -p "$CB" "$CH/.codex/skills/gsd-worktrees" "$WORK/other-codex"
printf 'old\n' > "$CH/.codex/skills/gsd-worktrees/SKILL.md"; printf '0.4.12\n' > "$CH/.codex/skills/gsd-worktrees/.gsd-worktrees-skill"
printf 'providers\tcodex\ncodex_skills\t%s\n' "$(cd "$CH/.codex/skills" && pwd -P)" > "$CB/.gsd-install-manifest"
env -u GSD_CODEX_SKILL_DIR HOME="$CH" CODEX_HOME="$WORK/other-codex" GSD_BIN_DIR="$CB" GSD_COPY_DIR="$WORK/codex-runtime3" \
  "$PKG/lib/install.sh" --reuse-install-config --no-user-hook >/dev/null
[ ! -e "$CH/.codex/skills/gsd-worktrees" ]
grep -q "^codex_skills	$(cd "$CH/.agents/skills" && pwd -P)\$" "$CB/.gsd-install-manifest"

# Move the source away without touching it: exercise a command from an isolated
# copy of the package, then remove only that temporary fixture.
FIXTURE="$WORK/source"
mkdir -p "$FIXTURE"
cp -R "$PKG/bin" "$PKG/lib" "$PKG/shims" "$PKG/skills" "$FIXTURE/"
cp "$PKG/install.sh" "$FIXTURE/install.sh"
printf '#!/bin/sh\nexit 0\n' > "$FIXTURE/bin/gsd-obsolete"
chmod +x "$FIXTURE/bin/gsd-obsolete"
GSD_BIN_DIR="$WORK/upgrade-bin" GSD_COPY_DIR="$WORK/upgrade-runtime" \
  GSD_CODEX_SKILL_DIR="$WORK/upgrade-skills" "$FIXTURE/lib/install.sh" --agent codex >/dev/null
rm "$FIXTURE/bin/gsd-obsolete"
ln -s "$WORK/unrelated-missing" "$WORK/upgrade-bin/unrelated"
# a command an older release had (0.8.0's gsd-clickup) goes on update
OLDREL="$WORK/share/gsd-toolkit/releases/0.8.0"; mkdir -p "$OLDREL/bin"
printf '#!/bin/sh\n' > "$OLDREL/bin/gsd-clickup"
ln -s "$OLDREL/bin/gsd-clickup" "$WORK/upgrade-bin/gsd-clickup"
GSD_BIN_DIR="$WORK/upgrade-bin" GSD_COPY_DIR="$WORK/upgrade-runtime" \
  "$FIXTURE/lib/install.sh" --reuse-install-config >/dev/null
[ ! -L "$WORK/upgrade-bin/gsd-obsolete" ]
[ ! -e "$WORK/upgrade-runtime/bin/gsd-obsolete" ]
[ -f "$WORK/upgrade-runtime/bin/gsd-obsolete.bak" ]
[ -L "$WORK/upgrade-bin/unrelated" ]
[ ! -e "$WORK/upgrade-bin/gsd-clickup" ] && [ ! -L "$WORK/upgrade-bin/gsd-clickup" ]
# an old link install's skill (a link into a checkout) is replaced by a copy
mkdir -p "$WORK/isolated-skills"; ln -s "$FIXTURE/skills/gsdt-flow" "$WORK/isolated-skills/gsdt-flow"
GSD_BIN_DIR="$WORK/isolated-bin" GSD_COPY_DIR="$WORK/isolated-runtime" \
  GSD_CLAUDE_SKILL_DIR="$WORK/isolated-skills" "$FIXTURE/lib/install.sh" >/dev/null
[ -d "$WORK/isolated-skills/gsdt-flow" ]
[ ! -L "$WORK/isolated-skills/gsdt-flow" ]
rm -rf "$FIXTURE"
"$WORK/isolated-bin/gsd-planning-repair" --help >/dev/null

if GSD_BIN_DIR="$PKG/bin" GSD_COPY_DIR="$WORK/unsafe" \
  GSD_CLAUDE_SKILL_DIR="$WORK/unused" "$PKG/lib/install.sh" > "$WORK/unsafe-output" 2>&1; then
  echo 'overlapping source destination was accepted' >&2; exit 1
fi
grep -q 'unsafe destination' "$WORK/unsafe-output"
mkdir -p "$WORK/other-runtime"
printf 'keep\n' > "$WORK/other-runtime/marker"
ln -s "$WORK/other-runtime" "$WORK/runtime-link"
if GSD_BIN_DIR="$WORK/link-bin" GSD_COPY_DIR="$WORK/runtime-link" \
  GSD_CLAUDE_SKILL_DIR="$WORK/unused" "$PKG/lib/install.sh" > "$WORK/link-output" 2>&1; then
  echo 'symlink runtime root was accepted' >&2; exit 1
fi
[ "$(cat "$WORK/other-runtime/marker")" = keep ]
[ ! -e "$WORK/other-runtime/bin" ]
if GSD_BIN_DIR="$WORK/link-bin" GSD_COPY_DIR="$WORK/runtime-link/" \
  GSD_CLAUDE_SKILL_DIR="$WORK/unused" "$PKG/lib/install.sh" > "$WORK/link-output" 2>&1; then
  echo 'trailing slash symlink runtime root was accepted' >&2; exit 1
fi
[ ! -e "$WORK/other-runtime/bin" ]
if GSD_BIN_DIR="$WORK/unsafe-skill-bin" GSD_CODEX_SKILL_DIR="$PKG/skills" \
  "$PKG/lib/install.sh" --agent codex > "$WORK/skill-output" 2>&1; then
  echo 'source-overlapping skill root was accepted' >&2; exit 1
fi
[ ! -e "$WORK/unsafe-skill-bin" ]
mkdir "$WORK/no-python"
for tool in bash dirname; do ln -s "$(command -v "$tool")" "$WORK/no-python/$tool"; done
if PATH="$WORK/no-python" GSD_BIN_DIR="$WORK/no-python-bin" \
  "$PKG/lib/install.sh" > "$WORK/python-output" 2>&1; then
  echo 'missing Python accepted' >&2; exit 1
fi
grep -q 'requires Python 3.7+' "$WORK/python-output"
[ ! -e "$WORK/no-python-bin" ]

# gsd-core: lib/install.sh adds it for each chosen agent that has none, through
# npx (a stub here: it records its args and stdin, and writes what the real
# installer leaves in the agent's dir).
CORE="$WORK/core"; mkdir -p "$CORE/stub"
cat > "$CORE/stub/npx" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$CORE_LOG"
cat >> "$CORE_STDIN"
[ -z "${CORE_FAIL:-}" ] || { echo 'npm error 404'; exit 1; }
d=$HOME/.claude
case " $* " in *" --codex "*) d=${CODEX_HOME:-$HOME/.codex} ;; esac
all="$*"; case " $all " in *" --config-dir "*) d=${all##*--config-dir }; d=${d%% *} ;; esac
mkdir -p "$d/gsd-core/bin"; printf '1.19.0\n' > "$d/gsd-core/VERSION"
printf '#!/bin/sh\n' > "$d/gsd-core/bin/gsd_run"; chmod +x "$d/gsd-core/bin/gsd_run"
SH
chmod +x "$CORE/stub/npx"
core_install() {  # $1=name, then lib/install.sh args; HOME is $CORE/<name>
  local name=$1; shift
  mkdir -p "$CORE/$name"
  printf 'rest of install.sh\n' | env -u GSD_NO_CORE -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u GSD_CODEX_SKILL_DIR \
    HOME="$CORE/$name" PATH="$CORE/stub:$PATH" CORE_LOG="$CORE/$name.log" CORE_STDIN="$CORE/$name.stdin" \
    GSD_BIN_DIR="$CORE/$name/bin" GSD_CLAUDE_SKILL_DIR="$CORE/$name/claude-skills" \
    ${CORE_ENV[@]+"${CORE_ENV[@]}"} "$PKG/lib/install.sh" "$@" > "$CORE/$name.out" 2>&1
}
CORE_ENV=()
core_install fresh --agent claude
grep -qx -- '-y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --profile=full' "$CORE/fresh.log"
[ ! -s "$CORE/fresh.stdin" ]   # the installer never reads install.sh's stdin
[ -x "$CORE/fresh/.claude/gsd-core/bin/gsd_run" ]
grep -q '✔ claude gsd-core 1.19.0' "$CORE/fresh.out"
[ -f "$CORE/fresh/claude-skills/gsdt-flow/SKILL.md" ]   # our skills are installed first
core_install fresh --agent claude   # it is there now: left alone
[ "$(wc -l < "$CORE/fresh.log")" -eq 1 ]
grep -q '• claude already has gsd-core 1.19.0' "$CORE/fresh.out"
core_install skip --agent claude --no-core
[ ! -e "$CORE/skip.log" ]
core_install skip --agent claude --reuse-install-config   # an update never installs it
[ ! -e "$CORE/skip.log" ]
CORE_ENV=(GSD_NO_CORE=1); core_install skip --agent claude; CORE_ENV=()
[ ! -e "$CORE/skip.log" ]
mkdir -p "$CORE/old/.claude/get-shit-done"   # the old GSD: no special case, gsd-core is installed
core_install old --agent claude
[ -s "$CORE/old.log" ]
CORE_ENV=(CODEX_HOME="$CORE/moved/codex-home" GSD_CODEX_SKILL_DIR="$CORE/moved/codex-skills")
core_install moved --agent codex; CORE_ENV=()
grep -qx -- "-y --package=@opengsd/gsd-core@latest -- gsd-core --codex --global --profile=full --config-dir $CORE/moved/codex-home" "$CORE/moved.log"
[ -x "$CORE/moved/codex-home/gsd-core/bin/gsd_run" ]
CORE_ENV=(CORE_FAIL=1); core_install failed --agent claude; CORE_ENV=()   # still exit 0
grep -q '⚠ gsd-core for claude not installed' "$CORE/failed.out"
grep -q 'run:  npx @opengsd/gsd-core@latest --claude --global --profile=full$' "$CORE/failed.out"
grep -q '^Done' "$CORE/failed.out"
mkdir "$CORE/nonode"
for tool in bash dirname python3 mkdir readlink ln rm mv cp cmp find sed grep cat head mktemp basename tr; do
  ln -s "$(command -v "$tool")" "$CORE/nonode/$tool"
done
mkdir -p "$CORE/nonpx"
env -u GSD_NO_CORE -u CLAUDE_CONFIG_DIR HOME="$CORE/nonpx" PATH="$CORE/nonode" \
  GSD_BIN_DIR="$CORE/nonpx/bin" GSD_CLAUDE_SKILL_DIR="$CORE/nonpx/claude-skills" \
  "$PKG/lib/install.sh" --agent claude > "$CORE/nonpx.out" 2>&1
grep -q '⚠ gsd-core not installed for claude: no npx' "$CORE/nonpx.out"
# install.sh --copy (what older releases' get.sh run on the release they
# downloaded) is this package's lib/install.sh; without a package it refuses
GSD_BIN_DIR="$WORK/compat-bin" GSD_COPY_DIR="$WORK/compat-runtime" GSD_CLAUDE_SKILL_DIR="$WORK/compat-skills" \
  "$PKG/install.sh" --copy --agent claude >/dev/null
[ "$(readlink "$WORK/compat-bin/gsd-list")" = "$WORK/compat-runtime/bin/gsd-list" ]
[ -f "$WORK/compat-runtime/install.sh" ] && [ -f "$WORK/compat-runtime/lib/install.sh" ]
cp "$PKG/install.sh" "$WORK/lone-install.sh"
if bash "$WORK/lone-install.sh" --copy > "$WORK/lone.out" 2>&1; then echo 'install.sh --copy outside a package was accepted' >&2; exit 1; fi
grep -q 'installs an unpacked package' "$WORK/lone.out"
# install.sh refuses a bad agent before it downloads or makes anything
if GSD_BIN_DIR="$WORK/gem-bin" bash "$PKG/install.sh" --agent gemini > "$WORK/gem.out" 2>&1; then echo 'gemini accepted' >&2; exit 1; fi
grep -q 'no longer supported' "$WORK/gem.out"; [ ! -e "$WORK/gem-bin" ]
echo 'copy installation: passed'
