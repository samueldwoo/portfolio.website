"""Flip reduced motion while content is STILL HIDDEN, then look for stranding.

The §10 unwind clears inline props on `.gsap-reveal` / `.pass` — including the
`opacity: 0` those elements are holding while they wait for their trigger. If
the CSS belts under `prefers-reduced-motion` do not cover them, that clear is
the difference between "revealed instantly" and "gone".

Run at the TOP of the page so as much as possible is still unrevealed.
"""
import json, sys, time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1]
SEL = (".reveal, .reveal-clip, .pass, .case-block, h1, h2, h3, .bubble, "
       ".bubble-list > *, .skills-list > *, .feature-chips > *, .section-title, "
       ".subhead, .case-title, .case-tagline, .case-index, .trip-mark, "
       ".timeline-rail, .case-rail-fill, .exp-item, .srline, .srline-mask")
JS = r"""
const sel = arguments[0], done = arguments[1];
const AUTHORED = ['pass-date','pass-k','pass-cities'];
function probe(){
  const hit=[],pend=[];
  document.querySelectorAll(sel).forEach(el=>{
    const cs=getComputedStyle(el), r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0)return;
    if(cs.display==='none'||cs.visibility==='hidden')return;
    const cls=String(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className||'');
    if(AUTHORED.some(a=>cls.split(/\s+/).indexOf(a)>-1))return;
    if(parseFloat(cs.opacity)>=0.99)return;
    (r.top<window.innerHeight?hit:pend).push(cls+' op='+cs.opacity+' top='+Math.round(r.top));
  });
  return {hit,pend};
}
let last=null,stable=0,waited=0;
(function s(){const p=probe();const sig=p.hit.join('|')+'#'+p.pend.length;
 stable=(sig===last)?stable+1:0;last=sig;waited+=250;
 if((stable>=3&&waited>6000)||waited>14000) done({hit:p.hit.slice(0,10),n:p.hit.length,pend:p.pend.length,ms:waited});
 else setTimeout(s,250);})();
"""
for page in ["", "projects/", "travel/"]:
    for scrolled in (False, True):
        o=Options(); o.add_argument("--headless=new"); o.add_argument("--hide-scrollbars")
        o.add_argument("--force-device-scale-factor=1")
        d=webdriver.Chrome(options=o); d.set_script_timeout(90)
        d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                          {"width":1440,"height":900,"deviceScaleFactor":1,"mobile":False})
        try:
            d.get(f"{BASE}/{page}")
            time.sleep(1.2)
            if scrolled:
                # part-way down, so some triggers have fired and some have not:
                # the mixed state is the one most likely to expose a hole.
                d.execute_script("window.scrollTo(0, document.documentElement.scrollHeight*0.45);")
                time.sleep(1.5)
            d.execute_cdp_cmd("Emulation.setEmulatedMedia",
                {"features":[{"name":"prefers-reduced-motion","value":"reduce"}]})
            r=d.execute_async_script(JS, SEL)
            where = "scrolled-45%" if scrolled else "at-top"
            print(f"[flip-strand] {page or '/':<11} {where:<12} "
                  f"STRANDED(reached)={r['n']} belowFold={r['pend']} settleMs={r['ms']} "
                  + json.dumps(r['hit'][:4]))
        finally:
            d.quit()
