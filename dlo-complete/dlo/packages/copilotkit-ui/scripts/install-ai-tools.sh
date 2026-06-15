#!/usr/bin/env bash
# DLO AI Tools Installer
# Installs: CodeWhale (code generation), open-code-review (code review)
set -euo pipefail

log()  { echo "[DLO install] $*"; }
ok()   { echo "[DLO install] ✓ $*"; }
fail() { echo "[DLO install] ✗ $*" >&2; exit 1; }

# ── CodeWhale ──────────────────────────────────────────────────────────────────
install_codewhale() {
  if command -v codewhale &>/dev/null; then
    ok "CodeWhale already installed: $(command -v codewhale)"
    return 0
  fi

  log "Installing CodeWhale from GitHub (Hmbown/CodeWhale)…"

  # Try npm global install if published
  if npm install -g codewhale 2>/dev/null; then
    ok "CodeWhale installed via npm"
    return 0
  fi

  # Clone and build from source
  local tmp_dir
  tmp_dir=$(mktemp -d)
  log "Cloning CodeWhale into $tmp_dir…"
  git clone --depth 1 https://github.com/Hmbown/CodeWhale.git "$tmp_dir/CodeWhale" 2>&1
  cd "$tmp_dir/CodeWhale"

  if [[ -f "package.json" ]]; then
    log "Building CodeWhale (npm)…"
    npm install 2>&1
    npm run build 2>/dev/null || true
    # Install globally or link
    npm link 2>/dev/null || npm install -g . 2>/dev/null || {
      # Fall back: put binary in PATH via ~/.local/bin
      mkdir -p "$HOME/.local/bin"
      if [[ -f "dist/cli.js" ]]; then
        echo '#!/usr/bin/env node' > "$HOME/.local/bin/codewhale"
        echo "require('$tmp_dir/CodeWhale/dist/cli.js')" >> "$HOME/.local/bin/codewhale"
        chmod +x "$HOME/.local/bin/codewhale"
      fi
    }
  elif [[ -f "requirements.txt" ]] || [[ -f "setup.py" ]] || [[ -f "pyproject.toml" ]]; then
    log "Building CodeWhale (pip)…"
    pip install -e . 2>&1 || pip3 install -e . 2>&1
  fi

  if command -v codewhale &>/dev/null; then
    ok "CodeWhale installed from source"
  else
    fail "CodeWhale installation failed — check the output above"
  fi
}

# ── open-code-review ──────────────────────────────────────────────────────────
install_ocr() {
  if command -v ocr &>/dev/null; then
    ok "open-code-review already installed: $(command -v ocr)"
    return 0
  fi

  log "Installing open-code-review (@alibaba-group/open-code-review)…"

  if npm install -g @alibaba-group/open-code-review 2>&1; then
    ok "open-code-review installed via npm"
    return 0
  fi

  # Try npx as a fallback detection method (don't install globally via npx)
  log "Trying alternative npm install path…"
  if npm install --prefix "$HOME/.local/npm-global" -g @alibaba-group/open-code-review 2>&1; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$HOME/.local/npm-global/bin/ocr" "$HOME/.local/bin/ocr" 2>/dev/null || true
    ok "open-code-review installed to ~/.local/npm-global"
    return 0
  fi

  fail "open-code-review installation failed — try: npm install -g @alibaba-group/open-code-review"
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  log "Starting DLO AI tool installation…"
  echo ""

  install_codewhale
  echo ""
  install_ocr
  echo ""

  log "All tools installed."
  echo ""
  echo "Installed:"
  command -v codewhale &>/dev/null && echo "  ✓ codewhale: $(command -v codewhale)"
  command -v ocr &>/dev/null       && echo "  ✓ ocr:       $(command -v ocr)"
}

main "$@"
