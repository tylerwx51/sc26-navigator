#!/usr/bin/env python3
"""Fit each floor-plan SVG to its OpenStreetMap building footprint (similarity transform).
Writes tools/src/georef.json: per layer, lon/lat = affine(svg x, y)."""
import sys,json,math
import numpy as np
from scipy.optimize import minimize
from scipy.spatial import cKDTree
import os; HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from svg_outline import shapes
osm=json.load(open(HERE+'/src/osmmap_buildings.json'))['elements']+json.load(open(HERE+'/src/osmeast_buildings.json'))['elements']
nodes={e['id']:(e['lat'],e['lon']) for e in osm if e['type']=='node'}
ways={e['id']:e for e in osm if e['type']=='way'}
LAT0,LON0=41.8505,-87.6180
KX=111320*math.cos(math.radians(LAT0)); KY=111320
def ll2m(lat,lon): return ((lon-LON0)*KX,(lat-LAT0)*KY)
def m2ll(x,y): return (LAT0+y/KY, LON0+x/KX)
def resample(pts,step):
    out=[]
    for a,b in zip(pts,pts[1:]+pts[:1]):
        a=np.array(a);b=np.array(b);n=max(1,int(np.linalg.norm(b-a)/step))
        for i in range(n): out.append(a+(b-a)*i/n)
    return np.array(out)
def fit(svgfile,wayid,mode='both'):
    sh=shapes(svgfile)[0]; sp=resample([tuple(p) for p in sh[6]],2.0)
    w=ways[wayid]; op=resample([ll2m(*nodes[n]) for n in w['nodes']],1.0)
    tree_o=cKDTree(op)
    # init: 180 rotation, bbox match
    sx0=(op[:,0].max()-op[:,0].min())/(sp[:,0].max()-sp[:,0].min())
    sy0=(op[:,1].max()-op[:,1].min())/(sp[:,1].max()-sp[:,1].min())
    s0=(sx0+sy0)/2
    def T(p,params):
        s,th,tx,ty=params; c,si=math.cos(th),math.sin(th)
        # svg y down -> flip y first, then rotate
        x=p[:,0]; y=-p[:,1]
        return np.stack([s*(c*x-si*y)+tx, s*(si*x+c*y)+ty],1)
    th0=math.pi
    t=T(sp,(s0,th0,0,0)); tx0=op[:,0].mean()-t[:,0].mean(); ty0=op[:,1].mean()-t[:,1].mean()
    def cost(params):
        t=T(sp,params); d1,_=tree_o.query(t)
        if mode=='svg2osm': return np.mean(np.minimum(d1,15)**2)
        tree_s=cKDTree(t); d2,_=tree_s.query(op)
        return np.mean(np.minimum(d1,15)**2)+np.mean(np.minimum(d2,15)**2)
    best=None
    for dth in np.radians([-6,-3,0,3,6]):
        r=minimize(cost,[s0,th0+dth,tx0,ty0],method='Nelder-Mead',options={'maxiter':6000,'xatol':1e-4,'fatol':1e-4})
        if best is None or r.fun<best.fun: best=r
    s,th,tx,ty=best.x
    print(svgfile,'cost',round(best.fun,2),'scale m/unit',round(s,4),'rot deg',round(math.degrees(th),2),'init s',round(sx0,3),round(sy0,3))
    return best.x
def to_geo_affine(params):
    # returns 6-coeff affine: lon = a*x + b*y + c ; lat = d*x + e*y + f   (svg units)
    s,th,tx,ty=params;c,si=math.cos(th),math.sin(th)
    # mx = s*(c*x + si*y)+tx ; my = s*(si*x - c*y)+ty
    a=s*c/KX; b=s*si/KX; cc=LON0+tx/KX
    d=s*si/KY; e=-s*c/KY; f=LAT0+ty/KY
    return [a,b,cc,d,e,f]
if __name__=='__main__':
    WEST=769452759; SOUTH=204886155; LAKE=136340574
    res={}
    for layer,way,mode in [('West1',WEST,'both'),('west2',WEST,'both'),('west3',WEST,'both'),('south1',SOUTH,'svg2osm'),('lakeside3',LAKE,'both')]:
        p=fit(HERE+f'/../app/src/main/assets/www/maps/{layer}.svg',way,mode); res[layer]={'params':list(p),'affine':to_geo_affine(p)}
    res['west4']=res['west3']
    json.dump(res,open(HERE+'/src/georef.json','w'),indent=1)
