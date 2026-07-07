# Create Branch UI Implementation Plan

> **For agentic workers:** **REQUIRED SUB‑SKILL:** `superpowers:subagent-driven-development` (recommended) **or** `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a UI component in the Git panel that lets users create a new Git branch (with an optional “Push ke remote” checkbox) and perform the checkout + push operations.

**Architecture:**
- A new markup row (`#git-branch-create-row`) is inserted **above** the existing branch‑selection row (`#git-branch-row`) in *public/index.html*.
- Styling re‑uses the existing CSS custom properties (`--bg`, `--border`, `--accent`).
- JavaScript validates the branch name, calls the backend `/api/git/checkout` endpoint, then (if checked) calls a new `/api/git/push` endpoint, finally refreshes the branch list UI.
- Backend adds a lightweight `/api/git/push` handler that runs `git push -u origin <branch>`.
- TDD is applied on both front‑end (Jest + jsdom) and back‑end (Jest + Supertest). 
- Documentation is updated in `README.md` and the design spec.

**Tech Stack:**
- Front‑end: vanilla ES6 JS, CSS custom properties (already used throughout the project).
- Back‑end: Node / Express (in `src/routes/gitRoutes.js`).
- Testing: Jest, Supertest (back‑end), Jest + jsdom (front‑end).

---

## Task 1 – Add HTML markup for “Buat Cabang Baru”

**Files:**
- **Modify:** `public/index.html` – insert markup **above** the existing `#git-branch-row` (line 758‑770).

```html
<!-- New UI: Buat Cabang Baru (opsional push) -->
<div id="git-branch-create-row" class="git-branch-create-row">
  <input
    type="text"
    id="git-new-branch-name"
    class="git-branch-create-input"
    placeholder="Nama cabang baru"
    aria-label="Nama cabang baru"
    autocomplete="off"
  />
  <label class="git-branch-push-label" for="git-push-remote">
    <input type="checkbox" id="git-push-remote" class="git-branch-push-checkbox" />
    Push ke remote
  </label>
  <button id="git-create-branch-btn" class="git-panel-btn git-branch-create-btn">
    Buat
  </button>
</div>
```

- **Effort:** ≈ 7 min.

### Sub‑steps (TDD)
- [ ] **Write failing test:** `src/tests/ui/gitPanelCreateBranch.test.js` – render fragment, assert row exists but button inactive until name entered.
- [ ] **Run test (should fail).**
- [ ] **Implement minimal markup** (as above).
- [ ] **Run test (should pass).**
- [ ] **Commit:**

```bash
git add public/index.html src/tests/ui/gitPanelCreateBranch.test.js
git commit -m "feat: add HTML markup for create‑branch UI"
```

---

## Task 2 – Add CSS styling for the new row

**Files:**
- **Modify:** `public/index.html` – within the existing `<style>` block, add rules after existing `.git-panel-btn` section.

```css
/* ---------- Create‑branch row ---------- */
.git-branch-create-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}
.git-branch-create-input {
  flex: 1 1 180px;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}
.git-branch-create-input:focus {
  border-color: var(--accent);
  outline: none;
}
.git-branch-push-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text);
}
.git-branch-create-btn {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  padding: 4px 10px;
  border-radius: 3px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s;
}
.git-branch-create-btn:hover {
  background: var(--accent-2);
}
[data-theme="dark"] .git-branch-create-row {
  background: var(--bg-3);
}
```

- **Effort:** ≈ 10 min.

### Sub‑steps (TDD)
- [ ] **Write failing test:** verify computed styles (button background = `var(--accent)`).
- [ ] **Run test (fail).**
- [ ] **Add CSS** (as above).
- [ ] **Run test (pass).**
- [ ] **Commit:**

```bash
git add public/index.html
git commit -m "style: add CSS for create‑branch UI"
```

---

## Task 3 – Add JavaScript interaction (frontend)

**Files:**
- **Modify:** `public/index.html` – locate the script block near the bottom (≈ line 2000) and add the handler.

```js
// ----- Create Branch UI handler -----
document.getElementById('git-create-branch-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('git-new-branch-name');
  const pushChk   = document.getElementById('git-push-remote');
  const branch    = nameInput.value.trim();

  if (!branch) { toastError('Nama cabang tidak boleh kosong'); return; }
  if (/[;&|`$(){}]/.test(branch)) { toastError('Nama cabang mengandung karakter tidak valid'); return; }

  // 1️⃣ Checkout (creates & switches to the new branch)
  const checkoutRes = await fetch('/api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: currentCwd, branch })
  });
  const checkoutData = await checkoutRes.json();
  if (!checkoutRes.ok) return toastError(checkoutData.error || 'Gagal buat cabang');

  // 2️⃣ Optional push
  if (pushChk.checked) {
    const pushRes = await fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: currentCwd, branch })
    });
    const pushData = await pushRes.json();
    if (!pushRes.ok) return toastError(pushData.error || 'Gagal push ke remote');
  }

  toastSuccess(`Cabang "${branch}" berhasil dibuat${pushChk.checked ? ' & dipush' : ''}`);
  // Refresh branch dropdown UI
  loadBranchList();
});
```

- **Effort:** ≈ 17 min.

### Sub‑steps (TDD)
- [ ] **Write failing test:** `src/tests/ui/gitPanelCreateBranchInteraction.test.js` – mock `fetch`, simulate click with name & checkbox, assert both endpoints called, toast shown.
- [ ] **Run test (fail).**
- [ ] **Implement handler** (as above).
- [ ] **Run test (pass).**
- [ ] **Commit:**

```bash
git add public/index.html src/tests/ui/gitPanelCreateBranchInteraction.test.js
git commit -m "feat: add JS logic for create‑branch UI"
```

---

## Task 4 – Add /api/git/push endpoint (backend)

**Files:**
- **Modify:** `src/routes/gitRoutes.js` – add a new `router.post('/api/git/push', ...)` after the existing `commit-push` route.

```js
// Push a branch to remote (origin)
router.post('/api/git/push', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.body.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const branch = req.body.branch;
  if (!branch || typeof branch !== 'string') {
    return res.status(400).json({ error: 'branch name required' });
  }
  if (/[;&|`$(){}]/.test(branch.trim())) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  const pushResult = await runGit(cwd, ['push', '-u', 'origin', branch.trim()], { timeout: 60000 });
  if (pushResult.code !== 0) {
    return res.status(400).json({ error: pushResult.stderr || 'git push failed' });
  }
  res.json({ ok: true, pushed: true, branch: branch.trim() });
});
```

- **Effort:** ≈ 13 min.

### Sub‑steps (TDD)
- [ ] **Write failing test:** `src/tests/api/gitPush.test.js` – mock `runGit` to return error, assert 400; then mock success, assert 200 `{ok:true}`.
- [ ] **Run test (fail).**
- [ ] **Implement handler** (as above).
- [ ] **Run test (pass).**
- [ ] **Commit:**

```bash
git add src/routes/gitRoutes.js src/tests/api/gitPush.test.js
git commit -m "feat: add git push endpoint for branch creation UI"
```

---

## Task 5 – Front‑end unit tests (Jest + jsdom)

**Files:**
- **Create:** `src/tests/ui/gitPanelCreateBranch.test.js` – render the fragment, verify DOM elements, ensure button disabled until name entered.
- **Create:** `src/tests/ui/gitPanelCreateBranchInteraction.test.js` – mock `fetch`, simulate user flow, verify correct API calls and toast messages.

- **Effort:** ≈ 30 min (both files).

### Sub‑steps (TDD)
- Write each test → run → fix → pass → commit.

```bash
git add src/tests/ui/gitPanelCreateBranch.test.js src/tests/ui/gitPanelCreateBranchInteraction.test.js
git commit -m "test: add Jest/jsdom tests for create‑branch UI"
```

---

## Task 6 – Back‑end unit tests (Supertest)

**Files:**
- **Create:** `src/tests/api/gitRoutes.test.js` – add tests for the new `/api/git/push` endpoint (success & failure cases).

- **Effort:** ≈ 15 min.

### Sub‑steps (TDD)
- Write tests → run → implement fix → pass → commit.

```bash
git add src/tests/api/gitRoutes.test.js
git commit -m "test: add Supertest coverage for git push endpoint"
```

---

## Task 7 – Documentation updates

**Files:**
- **Modify:** `README.md` – add a **“Create Branch UI”** section under *Git panel* explaining the new row, input, checkbox, button, and back‑end behaviour.
- **Modify:** `docs/superpowers/specs/2026-07-07-create-branch-design.md` – add an **Implementation notes** block referencing the new `/api/git/push` endpoint.

- **Effort:** ≈ 10 min.

### Sub‑steps (TDD not required, but commit after writing)
```bash
git add README.md docs/superpowers/specs/2026-07-07-create-branch-design.md
git commit -m "docs: describe new create‑branch UI and push option"
```

---

## Task 8 – Final integration test & clean‑up

**Steps:**
1. Run full test suite: `npm test`. Ensure 0 failures.
2. Manually launch the app, open the Git panel, verify the new row appears, create a branch with and without push, confirm toast messages and that the dropdown updates.
3. Fix any regressions (≤ 5 min).
4. Commit final changes.

- **Effort:** ≈ 5 min.

```bash
git add .
git commit -m "chore: final integration verification for create‑branch UI"
```

---

## Task 9 – Push branch & open PR

**Steps:**
```bash
git checkout -b feature/create-branch-ui
git push -u origin feature/create-branch-ui
# Open PR via GitHub UI or CLI
```
- **Effort:** ≈ 5 min.

---

# Effort Summary (approx.)
| Task | Time |
|------|------|
| 1 – HTML markup | 7 min |
| 2 – CSS styling | 10 min |
| 3 – JS interaction | 17 min |
| 4 – API push endpoint | 13 min |
| 5 – Front‑end unit tests | 30 min |
| 6 – Back‑end unit tests | 15 min |
| 7 – Docs updates | 10 min |
| 8 – Integration test & fix | 5 min |
| 9 – PR creation | 5 min |
| **Total** | **≈ 112 min** (≈ 2 h) |

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-07-create-branch-ui.md`.**

Two execution options:
1. **Subagent‑Driven (recommended)** – dispatch a fresh subagent per task, review spec compliance then code quality after each.
2. **Inline Execution** – run tasks sequentially in this session using `executing-plans`.

Which approach would you like to proceed with?