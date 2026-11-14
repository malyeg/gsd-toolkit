import json, os, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except ValueError:
    sys.exit(1)
if not isinstance(data, dict) or not isinstance(data.get("hooks"), dict):
    sys.exit(1)
ours = lambda h: isinstance(h, dict) and ("gsdt-worktree-guard" in str(h.get("command", "")) or "gsd-worktree-guard" in str(h.get("command", "")))
found = False
for event, groups in list(data["hooks"].items()):
    if not isinstance(groups, list):
        continue
    kept = []
    for g in groups:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            rest = [h for h in g["hooks"] if not ours(h)]
            if len(rest) < len(g["hooks"]):
                found = True
                if not rest:
                    continue
            g["hooks"] = rest
        kept.append(g)
    if kept: data["hooks"][event] = kept
    else: del data["hooks"][event]
if not found:
    sys.exit(1)
if not data["hooks"]: del data["hooks"]
if data:
    with open(path, "w") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
else:
    os.remove(path)
    try: os.rmdir(os.path.dirname(path))
    except OSError: pass
