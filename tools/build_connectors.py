#!/usr/bin/env python3
"""Find the stairs / escalator / elevator icons on each floor plan and write www/data/connectors.json.

The Mapplic floor plans draw these as unlabelled vector icons. Each SVG carries a legend
(left margin, one row per symbol), so every icon on the plan is classified by rasterising it
and comparing it to the legend icons (scale invariant, mirror tolerant). PORTALS adds the
hand-placed links between buildings, taken from labels printed on the plans themselves.

Usage: build_connectors.py <www_dir>
"""
import json
import math
import os
import re
import sys
TOK=re.compile(r'[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?')
NARGS={'m':2,'l':2,'h':1,'v':1,'c':6,'s':4,'q':4,'t':2,'a':7,'z':0}
def polys(d):
    toks=TOK.findall(d); i=0; cmd=None; x=y=0; sx=sy=0; out=[]; cur=[]; lc=None
    def bez(p0,p1,p2,p3):
        return [((1-t)**3*p0[0]+3*(1-t)**2*t*p1[0]+3*(1-t)*t*t*p2[0]+t**3*p3[0],(1-t)**3*p0[1]+3*(1-t)**2*t*p1[1]+3*(1-t)*t*t*p2[1]+t**3*p3[1]) for t in (0.25,0.5,0.75,1)]
    while i<len(toks):
        if re.match('[A-Za-z]',toks[i]): cmd=toks[i]; i+=1
        lo=cmd.lower(); rel=cmd.islower(); n=NARGS[lo]
        if lo=='z':
            if cur: out.append(cur); cur=[]
            x,y=sx,sy; lc=None; continue
        a=[float(t) for t in toks[i:i+n]]; i+=n
        if len(a)<n: break
        ox,oy=(x,y) if rel else (0,0)
        if lo=='m':
            if cur: out.append(cur)
            x,y=a[0]+ox,a[1]+oy; sx,sy=x,y; cur=[(x,y)]; cmd='l' if rel else 'L'; lc=None
        elif lo=='l': x,y=a[0]+ox,a[1]+oy; cur.append((x,y)); lc=None
        elif lo=='h': x=a[0]+(x if rel else 0); cur.append((x,y)); lc=None
        elif lo=='v': y=a[0]+(y if rel else 0); cur.append((x,y)); lc=None
        elif lo=='c':
            p1=(a[0]+ox,a[1]+oy);p2=(a[2]+ox,a[3]+oy);p3=(a[4]+ox,a[5]+oy)
            cur+=bez((x,y),p1,p2,p3); lc=p2; x,y=p3
        elif lo=='s':
            p1=(2*x-lc[0],2*y-lc[1]) if lc else (x,y);p2=(a[0]+ox,a[1]+oy);p3=(a[2]+ox,a[3]+oy)
            cur+=bez((x,y),p1,p2,p3); lc=p2; x,y=p3
        else:
            x,y=a[-2]+ox,a[-1]+oy; cur.append((x,y)); lc=None
    if cur: out.append(cur)
    return out
def bbox(ps):
    xs=[p[0] for q in ps for p in q]; ys=[p[1] for q in ps for p in q]
    return min(xs),min(ys),max(xs),max(ys)
N=20
def raster(ps,bb):
    x0,y0,x1,y1=bb; s=max(x1-x0,y1-y0) or 1
    cx,cy=(x0+x1)/2,(y0+y1)/2
    g=set()
    for j in range(N):
        for i in range(N):
            px=cx+((i+.5)/N-.5)*s; py=cy+((j+.5)/N-.5)*s; c=0
            for q in ps:
                for k in range(len(q)):
                    (ax,ay),(bx,by)=q[k],q[k-1]
                    if (ay>py)!=(by>py) and px<ax+(py-ay)*(bx-ax)/(by-ay): c^=1
            if c: g.add((i,j))
    return g
def iou(a,b): return len(a&b)/max(1,len(a|b))
ROWS={'entrance':85,'elevator':97,'escalator':108,'stairs':120,'info':132,'phone':143,'mamava':153,'food':164,'aid':175,'fountain':186,'men':197,'women':208,'allg':220}
import xml.etree.ElementTree as ET
def mat(t):
    M=[1,0,0,1,0,0]
    for name,args in re.findall(r'(\w+)\(([^)]*)\)',t or ''):
        a=[float(x) for x in re.findall(r'-?[\d.]+(?:e-?\d+)?',args)]
        if name=='matrix': N2=a
        elif name=='translate': N2=[1,0,0,1,a[0],a[1] if len(a)>1 else 0]
        elif name=='scale': N2=[a[0],0,0,a[1] if len(a)>1 else a[0],0,0]
        elif name=='rotate':
            r=math.radians(a[0]); c,s_=math.cos(r),math.sin(r); N2=[c,s_,-s_,c,0,0]
            if len(a)==3: N2=mul(mul([1,0,0,1,a[1],a[2]],N2),[1,0,0,1,-a[1],-a[2]])
        else: continue
        M=mul(M,N2)
    return M
def mul(A,B):
    a,b,c,d,e,f=A; g,h,i,j,k,l=B
    return [a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f]
def elements(f):
    root=ET.parse(f).getroot()
    out=[]
    def walk(el,M):
        M=mul(M,mat(el.get('transform')))
        tag=el.tag.split('}')[-1]
        if tag=='path' and el.get('d'):
            try: ps=polys(el.get('d'))
            except Exception: ps=None
            if ps:
                ps=[[(M[0]*x+M[2]*y+M[4],M[1]*x+M[3]*y+M[5]) for x,y in q] for q in ps]
                out.append((ps,bbox(ps)))
        if tag in ('defs','clipPath','mask','symbol'): return
        for c in el: walk(c,M)
    walk(root,[1,0,0,1,0,0])
    return out
def run(f):
    els=elements(f)
    legend={}
    for ps,bb in els:
        if bb[2]<42 and bb[0]>25:
            cy=(bb[1]+bb[3])/2
            for k,y in ROWS.items():
                if abs(cy-y)<5: legend.setdefault(k,[]).append((ps,bb))
    L={}
    for k,v in legend.items():
        ps=[q for p,_ in v for q in p]; bb=bbox(ps); L[k]=(raster(ps,bb),max(bb[2]-bb[0],bb[3]-bb[1]))
    res=[]
    for ps,bb in els:
        if bb[0]<60: continue
        sz=max(bb[2]-bb[0],bb[3]-bb[1])
        if not (2<sz<9): continue
        r=raster(ps,bb); rf={(N-1-i,j) for i,j in r}
        best=max(((max(iou(r,lr),iou(rf,lr)),k) for k,(lr,_) in L.items()))
        if best[0]>0.55 and best[1] in ('escalator','stairs','elevator'):
            res.append({'k':best[1],'x':round((bb[0]+bb[2])/2,1),'y':round((bb[1]+bb[3])/2,1),'score':round(best[0],2)})
    return res

FLOORS = {"West1": "West1.svg", "west2": "west2.svg", "west3": "west3.svg", "west4": "west4.svg",
          "south1": "south1.svg", "lakeside3": "lakeside3.svg"}
KIND = {"escalator": "esc", "elevator": "elev", "stairs": "stairs"}

# Links between buildings. Positions are where the plan itself prints the label/arrow.
PORTALS = [
    {"id": "skybridge-w3", "l": "west3", "x": 215, "y": 492, "label": "Skybridge → South",
     "to": "south1", "title": "Skybridge to the South Building",
     "text": "From the east end of the West 3 Central Concourse (near Career Fair) the Skybridge crosses "
             "Dr. Martin Luther King Jr. Drive to the South Building. It arrives on the South Building's upper "
             "level (Level 3 on the overview; not one of these maps). Take escalators or stairs down to "
             "South Level 1 for the Grand Ballroom (S100) and rooms S101–S106."},
    {"id": "concourse-l3", "l": "lakeside3", "x": 640, "y": 386, "label": "Grand Concourse",
     "to": "south1", "title": "Grand Concourse to the North & South Buildings",
     "text": "The Lakeside Level 3 entrance on the west side (by Lake Shore Dr) leads over the Grand Concourse "
             "bridge to the North & South Buildings. From the South Building, the Skybridge leads on to West 3."},
    {"id": "north-s1", "l": "south1", "x": 178, "y": 722, "label": "To North Bldg L1",
     "to": "overview", "title": "South Level 1 inset: to the North Building",
     "text": "This small inset on the South Level 1 plan is the passage to North Building Level 1 "
             "(the North Building has no detailed map here). The Grand Concourse between the North and "
             "South buildings continues to Lakeside Level 3."},
]


def main(www):
    floors = {}
    for lid, fn in FLOORS.items():
        icons = run(os.path.join(www, "maps", fn))
        floors[lid] = sorted(({"k": KIND[i["k"]], "x": i["x"], "y": i["y"]} for i in icons),
                             key=lambda i: (i["k"], i["y"], i["x"]))
    out = {"floors": floors, "portals": PORTALS}
    with open(os.path.join(www, "data", "connectors.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    for lid, v in floors.items():
        n = {k: sum(1 for i in v if i["k"] == k) for k in KIND.values()}
        print(f"{lid}: {n}")


if __name__ == "__main__":
    main(sys.argv[1])
