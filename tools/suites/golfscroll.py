"""Desktop drag at several scroll depths. The hero is pinned and its canvas
wrapper is SCALED during the scrub, so localPt() (which divides by the canvas's
transformed bounding rect) may not agree with untransformed ball coords."""
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
def cdp(d,m,p): return d.execute_cdp_cmd(m,p)
o=Options(); o.add_argument("--headless=new"); o.add_argument("--hide-scrollbars"); o.add_argument("--force-device-scale-factor=1")
d=webdriver.Chrome(options=o)
try:
    cdp(d,"Emulation.setDeviceMetricsOverride",{"width":1440,"height":900,"deviceScaleFactor":1,"mobile":False})
    d.get("http://localhost:8123/index.html")
    try: d.execute_script("return document.fonts.ready")
    except Exception: pass
    time.sleep(2.8)
    print(f"\n  scrollY | wrap transform                  | rectW  | ball screen | press->phase")
    for sy in (0, 60, 150, 300, 500, 700):
        d.execute_script("window.__puttTest.reset()"); time.sleep(0.4)
        d.execute_script("window.scrollTo({top:arguments[0],behavior:'instant'})", sy); time.sleep(1.2)
        d.execute_script("window.__puttTest.place(0.5,0.5)"); time.sleep(0.3)
        g=d.execute_script("""
          const c=document.querySelector('canvas.hero-canvas');
          const wr=document.querySelector('.hero-canvas-wrap');
          const r=c.getBoundingClientRect();
          const s=window.__puttTest.state();
          return {tr:getComputedStyle(wr).transform, rw:Math.round(r.width),
                  sc: c.getBoundingClientRect().width / (parseFloat(c.style.width)||1),
                  bx:Math.round(r.left+s.ball[0]*(r.width/(parseFloat(c.style.width)||1))),
                  by:Math.round(r.top+s.ball[1]*(r.height/(parseFloat(c.style.height)||1))),
                  cw:c.width, sy:Math.round(window.pageYOffset)};""")
        cdp(d,"Input.dispatchMouseEvent",{"type":"mousePressed","x":g['bx'],"y":g['by'],"button":"left","clickCount":1})
        time.sleep(0.1)
        ph=d.execute_script("return window.__puttTest.state().phase")
        cdp(d,"Input.dispatchMouseEvent",{"type":"mouseReleased","x":g['bx'],"y":g['by'],"button":"left","clickCount":1})
        tr=(g['tr'] or 'none')[:30]
        print(f"  {g['sy']:>7} | scale={g['sc']:.4f} | {g['rw']:>5}  | {g['bx']},{g['by']:<7} | {ph}"
              f"{'   <-- DEAD' if ph!='aiming' else ''}")
finally: d.quit()
