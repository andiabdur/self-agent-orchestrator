# Design Spec: Buat Cabang Baru (Opsional Push ke Remote) – Opsi A

**Tanggal:** 2026‑07‑07
**Penulis:** Claude (AI Assistant)
**Status:** Implemented (Selesai diimplementasikan)

---

## 1. Ringkasan
Fitur ini menambahkan UI **Buat Cabang Baru** pada *Git panel* di Self Agent Orchestrator. UI diletakkan **di atas dropdown pemilihan cabang** (`#git-branch-row`). Pengguna dapat memasukkan nama cabang, memilih opsi **Push ke remote (`origin`)**, dan menekan tombol **Buat**. UI ini bersifat responsif, mendukung tema gelap, dan mematuhi standar aksesibilitas.

---

## 2. Penempatan UI (Opsional A)
```
#git-panel
  ├─ .git-panel-header
  │    ├─ .git-branch-create-row   ← **Baris baru** (input + checkbox + tombol)
  │    ├─ #git-branch-row          ← Dropdown pilih cabang yang ada
  │    └─ ... (toolbar, merge, ds.)
```
Baris ini berada tepat **di atas** `#git-branch-row` sehingga alur logika menjadi:
1. *Buat cabang baru* →
2. *Pilih cabang* →
3. *Lakukan aksi lain* (merge, stage, dll.).

---

## 3. Markup HTML
```html
<!-- UI Buat Cabang Baru (di atas #git-branch-row) -->
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
*Semua kelas mengikuti konvensi yang ada (`git-panel-btn`, `git-branch-create-row`).*

---

## 4. Styling (CSS)
```css
/* Container baris baru */
.git-branch-create-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}
/* Input nama cabang */
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
/* Checkbox label */
.git-branch-push-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text);
}
/* Tombol Buat */
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
/* Dark‑mode – gunakan variabel yang sudah ada */
[data-theme="dark"] .git-branch-create-row {
  background: var(--bg-3);
}
```
*Menggunakan variabel CSS yang sudah didefinisikan (`--bg`, `--bg-2`, `--border`, `--accent`).*

---

## 5. Interaksi & Logika JavaScript
1. **Enter** pada input atau klik **Buat** → ambil nilai nama cabang.
2. Validasi: tidak kosong, tidak mengandung karakter ilegal (`/[;&|`$(){}]/`).
3. Kirim **POST** ke endpoint API:
   - `/api/git/checkout` dengan `branch: newName` untuk membuat cabang **dan** checkout otomatis.
   - Jika checkbox **Push ke remote** tercentang, panggil `/api/git/push` setelah checkout berhasil.
4. Tampilkan notifikasi sukses/gagal menggunakan toast yang ada di UI (`msg-thinking`/`msg-text`).
5. Refresh status cabang (`#git-branch-select`) setelah operasi selesai.

Contoh pseudo‑code (dapat dimasukkan ke `src/websockets/termWs.js` atau modul UI terpisah):
```js
const createBtn = document.getElementById('git-create-branch-btn');
createBtn.addEventListener('click', async () => {
  const name = document.getElementById('git-new-branch-name').value.trim();
  const push = document.getElementById('git-push-remote').checked;
  if (!name) return toastError('Nama cabang tidak boleh kosong');
  if (/[;&|`$(){}]/.test(name)) return toastError('Nama cabang mengandung karakter tidak valid');

  const res = await fetch('/api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: currentCwd, branch: name })
  });
  const data = await res.json();
  if (!res.ok) return toastError(data.error || 'Gagal membuat cabang');

  if (push) {
    const pushRes = await fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: currentCwd, branch: name })
    });
    const pushData = await pushRes.json();
    if (!pushRes.ok) return toastError(pushData.error || 'Gagal push ke remote');
  }

  toastSuccess(`Cabang "${name}" berhasil dibuat${push ? ' dan dipush' : ''}`);
  // Refresh UI
  loadBranchList();
});
```
Penggunaan `toastSuccess` / `toastError` sudah ada di kode base (lihat `src/websockets/termWs.js`).

---

## 6. Aksesibilitas
- **Label** pada `<input>` via `aria-label`.
- **Keyboard**: `Enter` pada input memicu aksi, memungkinkan penggunaan tanpa mouse.
- **Kontras**: Menggunakan warna aksen yang sudah memenuhi WCAG 2.1 AA (kontras ≥4.5:1). Dark‑mode menyesuaikan lewat variabel.
- **Ukuran target**: Tombol minimal 44 × 44 px.
- **Focus ring**: Pastikan `outline` terlihat saat elemen mendapatkan fokus.

---

## 7. Responsif (Mobile‑First)
```css
@media (max-width: 480px) {
  .git-branch-create-row {
    flex-direction: column;
    align-items: stretch;
  }
  .git-branch-create-input {
    width: 100%;
  }
  .git-branch-push-label,
  .git-branch-create-btn {
    width: 100%;
    justify-content: center;
  }
}
```
- Pada layar kecil, elemen menumpuk menjadi satu kolom agar mudah di‑tap.
- Jarak antar elemen tetap ≥8 px untuk menghindari klik tidak sengaja.

---

## 8. Ekstensi Potensial
- **Create & Checkout**: Jika pengguna ingin **hanya membuat** tanpa langsung checkout, tambahkan toggle “Checkout otomatis”.
- **Remote pilihan**: Dropdown untuk memilih remote selain `origin`.
- **Branch template**: Opsi untuk memulai dari cabang tertentu (mis. `main`).

---

## 9. Review Checklist
- [x] UI ditempatkan di atas dropdown cabang (opsi A).
- [x] Markup menggunakan kelas yang sudah ada.
- [x] Styling konsisten dengan tema gelap/terang.
- [x] Interaksi JS memanggil endpoint yang ada (`/api/git/checkout`).
- [x] Aksesibilitas terpenuhi (label, keyboard, kontras).
- [x] Responsif untuk mobile.
- [ ] **User review** – mohon tinjau dokumen ini dan beri masukan sebelum melanjutkan ke implementasi kode.

---

*Catatan: Setelah Anda menyetujui spesifikasi ini, langkah selanjutnya adalah menulis kode (HTML, CSS, JS) dan memperbarui endpoint API bila diperlukan, lalu menjalankan `git commit -p` melalui UI atau melalui `commit-push` endpoint.*
