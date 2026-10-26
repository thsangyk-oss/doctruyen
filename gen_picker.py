import json, html as H

cl = json.load(open("sidon_clusters.json", encoding="utf-8"))
cl.sort(key=lambda c: (c["gender"] != "nam", -c["f0"]))
male = [c for c in cl if c["gender"] == "nam"]
female = [c for c in cl if c["gender"] == "nữ"]
print("male:", len(male), "female:", len(female))

cards = []
mi = fi = 0
for c in cl:
    if c["gender"] == "nam":
        nm = f"Sidon M{mi:02d}"; mi += 1
    else:
        nm = f"Sidon F{fi:02d}"; fi += 1
    g = c["gender"]
    badge = "nam" if g == "nam" else "nữ"
    txt = H.escape(c["text"][:110])
    dups = f" · x{c['members']}" if c["members"] > 1 else ""
    cards.append(f'''<div class="card" id="c{c['idx']}">
 <div class="top"><b>{nm}</b><span class="g {'m' if g=='nam' else 'f'}">{badge}</span>
 <span class="f0">{c['f0']}Hz · {c['dur']}s{dups}</span></div>
 <audio controls preload="none" src="clips/{c['wav']}"></audio>
 <div class="txt">{txt}…</div>
 <div class="row2"><input value="{nm}" id="n{c['idx']}" maxlength="40">
 <button onclick="enroll({c['idx']},'{c['wav']}','{g}')">+ Thêm</button></div>
 <div class="st" id="s{c['idx']}"></div></div>''')

page = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Chọn giọng Sidon</title><style>
body{font-family:system-ui;background:#101418;color:#ddd;margin:0;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px}p{color:#999;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.card{background:#1a2129;border:1px solid #2a3440;border-radius:10px;padding:12px}
.top{display:flex;gap:8px;align-items:baseline;margin-bottom:6px}
.g{font-size:11px;padding:2px 8px;border-radius:8px}.g.m{background:#1e3a5f;color:#7db3f0}.g.f{background:#4a2440;color:#e896d0}
.f0{color:#888;font-size:11px}audio{width:100%;height:34px;margin:4px 0}
.txt{font-size:12px;color:#8a9;min-height:28px}
.row2{display:flex;gap:8px;margin-top:6px}
input{flex:1;background:#0d1117;border:1px solid #333;border-radius:6px;color:#ddd;padding:6px 8px;font-size:13px}
button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 14px;cursor:pointer}
button:disabled{background:#333;color:#777}
.st{font-size:12px;margin-top:4px;color:#7c8}.st.err{color:#e77}
</style>
<h1>Kho giọng Sidon — ''' + str(len(cl)) + ''' giọng</h1>
<p>Nguồn: dataset Kontact/vieneu_sidon_noise_removal · nghe rồi bấm <b>+ Thêm</b> để enroll (đổi tên được). Giọng mới xuất hiện ngay trong app, không cần restart.</p>
<div class=grid>''' + "".join(cards) + '''</div>
<script>
async function enroll(i,wav,g){
 const st=document.getElementById('s'+i),btn=event.target;
 btn.disabled=true; st.textContent='đang enroll…'; st.className='st';
 const name=document.getElementById('n'+i).value.trim()||('Sidon '+i);
 const r=await fetch('/api/tts/enroll',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({name,ref_wav:'C:/Users/ADMIN/Documents/Doctruyen/public/voicepicker/clips/'+wav,gender:g,description:'giọng từ kho Sidon'})});
 const d=await r.json();
 if(d.ok){st.textContent='✓ đã thêm — giờ có '+d.total+' giọng'}
 else{st.textContent='✗ '+(d.error||'lỗi');st.className='st err';btn.disabled=false}
}
</script>'''

open("public/voicepicker/index.html", "w", encoding="utf-8").write(page)
print("wrote page, cards:", len(cards))
