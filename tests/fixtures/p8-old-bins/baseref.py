import json, os, shutil, sys, tempfile
mode, local = sys.argv[1], os.path.realpath(sys.argv[2])

def read(path):  # → (settings dict or None, parsed?)
    if not os.path.exists(path):
        return None, True
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None, False
    return (data, True) if isinstance(data, dict) else (None, False)

data, ok = read(local)
for path in sys.argv[2:]:
    s = data if path == sys.argv[2] else read(path)[0]
    wt = s.get("worktree") if s else None
    ref = wt.get("baseRef") if isinstance(wt, dict) else None
    if isinstance(ref, str):
        print("head" if ref == "head" else "other:" + ref); sys.exit(0)
if not ok or (data is not None and "worktree" in data and not isinstance(data["worktree"], dict)):
    print("invalid"); sys.exit(0)
if mode != "ensure":
    print("missing"); sys.exit(0)
data = data if data is not None else {}
data.setdefault("worktree", {})["baseRef"] = "head"
d = os.path.dirname(local)
os.makedirs(d, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=d, prefix=".settings.local.")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
if os.path.exists(local):
    shutil.copymode(local, tmp)
else:
    os.chmod(tmp, 0o644)
os.replace(tmp, local)
print("set")
