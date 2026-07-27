# Portable Windows build

`claudian-windows-2.0.41-portable.zip` contains the three files Obsidian needs:

- `main.js`
- `manifest.json`
- `styles.css`

Extract them into:

```text
<vault>\.obsidian\plugins\realclaudian\
```

This is a branch test build, not a published upstream release. Verify the ZIP
with `SHA256SUMS` before installation. The directory name must match the
`realclaudian` ID in `manifest.json`.
