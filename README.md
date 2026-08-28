# Insurance Illustration Reader

อ่านเอกสาร Word (Summary Illustration) ของกรมธรรม์ประกันชีวิต แล้วสร้างกราฟเปรียบเทียบ, ตาราง, และคำนวณ XIRR / จุดคุ้มทุนให้อัตโนมัติ — รองรับทั้งรูปแบบ Guaranteed/Non-Guaranteed (PAR เช่น SunJoy, Chubb MyLegacy) และ Account Value/Surrender Value/Death Benefit (UL/IUL เช่น SunRise)

ทุกอย่างประมวลผลในเบราว์เซอร์ฝั่ง client เท่านั้น ไม่มีการอัปโหลดเอกสารขึ้นเซิร์ฟเวอร์ใด ๆ

## โครงสร้างไฟล์

```
insurance-illustration-reader/
├── index.html              HTML shell — โครงหน้าเว็บ
├── style.css                CSS ทั้งหมด (รวม @font-face)
├── app.js                    Logic หลักทั้งหมด: parser, XIRR engine, chart rendering, UI
├── fonts/                    ไฟล์ font จริง (Kanit, Inter) — ไม่ได้ embed เป็น base64 แล้ว
│   ├── inter-400/500/600/700.woff2
│   └── kanit-400/500/600/700-{thai,latin}.woff2
└── vendor/                   Library ภายนอกที่ vendor ไว้ใช้งานแบบ offline
    ├── chart.umd.js           Chart.js v4.4.4
    └── mammoth.browser.min.js Mammoth.js (แปลง .docx → HTML ในเบราว์เซอร์)
```

**หมายเหตุ**: ไฟล์นี้แยกออกมาจากไฟล์ single-file เดิม (`.html` ไฟล์เดียวขนาด ~1.25MB ที่ embed ทุกอย่างเป็น base64) เพื่อให้:
- `git diff` อ่านออกว่าแก้อะไรจริง ๆ ในแต่ละ commit
- เปิดแก้ไขต่อใน Cursor/VS Code ได้สะดวกกว่า (แยกไฟล์ตามหน้าที่)
- ยังใช้งานแบบ **offline ได้เหมือนเดิม** เพราะ vendor library และ font ทั้งหมดเก็บเป็นไฟล์จริงในโฟลเดอร์ ไม่ได้โหลดจาก CDN

## วิธีรัน

เปิด `index.html` ตรง ๆ ในเบราว์เซอร์ได้เลย (double-click หรือ `file://` ก็ใช้งานได้ปกติ) **หรือ** รันผ่าน local server เพื่อความเสถียร:

```bash
# Python
python3 -m http.server 8000
# แล้วเปิด http://localhost:8000

# หรือ Node (ถ้ามี npx)
npx serve .
```

## ฟีเจอร์หลัก

- **อ่านเอกสาร .docx อัตโนมัติ** — ตรวจจับ SV/DB, Guaranteed/Non-Guaranteed, Account Value ด้วย keyword matching (ไม่ hardcode ต่อสินค้า)
- **โหมด "เปรียบเทียบกราฟ"** — กราฟแท่ง/เส้น เปรียบเทียบสูงสุด 2 สินค้าพร้อมกัน, toggle SV/DB, USD/บาท (บาทแสดงแบบ แสน/ล้าน ปัดขึ้น), ช่วงเวลา 10/20/40/ทั้งหมดปี
- **โหมด "ตาราง + XIRR"** — คำนวณ XIRR ทั้งแบบจ่ายเบี้ยรายปีปกติ และแบบ Prepayment (ชำระล่วงหน้าครั้งเดียว), หา Cash Breakeven และ Guaranteed Breakeven ด้วย linear interpolation (ทศนิยม 1 ตำแหน่ง)
- **Death Benefit แบบ PAR** — แยกกราฟแท่งเป็น 2 กลุ่มเปรียบเทียบ (B) Guaranteed vs (A)+(C+D)=(E) ให้เห็นว่าใครสูงกว่า แทนการ stack รวมกันแบบเข้าใจผิด
- **Prepayment parsing แบบยืดหยุ่น** — รองรับทั้ง SunLife-style ("Total initial annual premium" + "Total Prepaid Amount") และ Chubb-style ("Total Prepayment" / "Adjusted Final Amount" หลังหัก Rebate)
- ธงเคลื่อนไหว (CSS animation) ปักจุด Breakeven บนกราฟโดยตรง, tooltip กำหนดสีเอง (ค่าเงินฟ้าอ่อน, XIRR แดง/เขียวตามเครื่องหมาย)

## งานที่กำลังจะทำต่อ (ดูรายละเอียดในบทสนทนาที่พัฒนาไฟล์นี้)

**Partial Surrender / Withdrawal Scenario** — เอกสารบางฉบับ (เช่น SunJoy ที่มีการถอนบางส่วน) จะมีตารางเพิ่มเติมชื่อ `SURRENDER VALUE AFTER CASH WITHDRAWAL` และ `DEATH BENEFIT AFTER CASH WITHDRAWAL` ซ้อนอยู่กับตารางฐาน (No Withdrawal) เดิม — แผนคือ:

1. เพิ่ม parser จับตาราง "...AFTER CASH WITHDRAWAL" แยกจากตารางฐาน (marker ตรงข้ามกับ logic เดิมที่ข้ามคำว่า "withdrawal")
2. อ่านค่าถอน (Cash Withdrawal Amount) และปีเริ่มถอนจากข้อมูลในตารางโดยตรง ไม่ hardcode
3. เก็บข้อมูล 2 ชุดแยกกันต่อสินค้า พร้อม parameter ที่อ่านได้จริง
4. เพิ่ม toggle "สถานการณ์: No Withdrawal / Withdrawal" ระดับเดียวกับ toggle SV/DB — ให้ทุก component (กราฟ/ตาราง/XIRR) สลับตามนี้
5. รองรับ "Notional Amount After Cash Withdrawal" เป็นเส้นอ้างอิงใหม่ในกราฟ Death Benefit เพราะสะท้อนผลกระทบจากการถอนโดยตรง
6. ถ้าเปรียบเทียบ 2 สินค้า ไม่บังคับให้เลือกสถานการณ์เดียวกัน แต่ควรแนะนำ user ให้เลือกเหมือนกันเพื่อเทียบธรรมสนามเดียวกัน

รายละเอียดโครงสร้างตาราง/คอลัมน์ที่ตรวจสอบแล้วจากเอกสารตัวอย่างจริง อยู่ในบทสนทนา Claude ที่ใช้พัฒนาไฟล์นี้ (ยังไม่ implement โค้ด — วิเคราะห์ไว้เป็น spec รอดำเนินการ)

## ข้อจำกัดที่ควรทราบ

- Parser จับคู่ตารางด้วย keyword (Guaranteed, Non-Guaranteed, Surrender Value, Death Benefit, Account Value ฯลฯ) หากบริษัทประกันอื่นใช้โครงสร้างตารางต่างไปมาก ผลลัพธ์อาจคลาดเคลื่อน — ควรตรวจทานตัวเลขกับเอกสารต้นฉบับก่อนใช้กับลูกค้าเสมอ
- XIRR คำนวณจากกระแสเงินสดสมมติ (เบี้ยจ่ายรายปีสม่ำเสมอ เทียบกับ Surrender Value ที่ได้รับ ณ ปีนั้น) เป็นตัวเลขประมาณการเพื่อการวิเคราะห์เบื้องต้น ไม่ใช่ตัวเลขที่รับประกันหรือใช้แทนเอกสารประกอบสัญญา
