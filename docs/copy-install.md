# How a package is installed (0.10.x and earlier)

This page is retired. It described `lib/install.sh`, the installer behind
`install.sh` and `gsdt-update` in 0.10.x and earlier: it copied the toolkit
into `~/.local/share/gsd-toolkit/releases/X.Y.Z/` and linked the commands into
`~/.local/bin`. It needed Python 3.7+, Perl, Bash and Git.

From 1.0.0 the toolkit is an npm package and nothing here applies:

```sh
npm i -g gsd-toolkit
gsdt-setup
```

See [Install in the README](../README.md#install), and
[Moving from 0.10.x](../README.md#moving-from-010x) if you have the old
install. How releases work now: [releases.md](releases.md).
