import sys,re,json
from svgpathtools import parse_path
import xml.etree.ElementTree as ET
ns='{http://www.w3.org/2000/svg}'
def shapes(f):
    t=ET.parse(f); out=[]
    for el in t.iter():
        tag=el.tag.replace(ns,'')
        pts=None
        if tag=='path':
            try:
                p=parse_path(el.get('d')); pts=[(seg.start.real,seg.start.imag) for seg in p]
            except Exception: pass
        elif tag in('polygon','polyline'):
            nums=[float(x) for x in re.split(r'[\s,]+',el.get('points').strip()) if x]
            pts=list(zip(nums[::2],nums[1::2]))
        elif tag=='rect':
            x=float(el.get('x',0));y=float(el.get('y',0));w=float(el.get('width'));h=float(el.get('height'))
            pts=[(x,y),(x+w,y),(x+w,y+h),(x,y+h)]
        if pts and len(pts)>2:
            xs=[p[0] for p in pts];ys=[p[1] for p in pts]
            out.append(((max(xs)-min(xs))*(max(ys)-min(ys)),tag,el.get('id'),el.get('fill'),[round(min(xs),1),round(min(ys),1),round(max(xs),1),round(max(ys),1)],len(pts),pts))
    out.sort(key=lambda s:-s[0]); return out
for f in sys.argv[1:]:
    print('==',f)
    for s in shapes(f)[:6]: print(s[:6])
