#!/usr/bin/env python3
"""Build and locally serve an indexed, bounded AIS replay database (no third-party packages)."""
import argparse,csv,datetime as dt,gzip,hashlib,json,os,re,sqlite3,sys,tempfile
from http.server import BaseHTTPRequestHandler,HTTPServer,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse,parse_qs

FIELDS=['source_timestamp_utc','mmsi','latitude_deg','longitude_deg','sog_knots','cog_deg','heading_deg','mobile_type','ship_type','name','navigational_status','sog_quality','cog_quality','heading_quality']
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 return h.hexdigest()
def validtime(s):
 try:
  if len(s)!=20 or not s.endswith('Z'):return False
  return dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').strftime('%Y-%m-%dT%H:%M:%SZ')==s
 except (ValueError,TypeError):return False

def build(a):
 src=Path(a.input).expanduser().resolve(); meta=Path(str(src)+'.report.json'); dst=Path(a.output).expanduser().resolve()
 if dst.exists() or dst==src: raise ValueError('Database already exists or equals input')
 if not meta.is_file():raise ValueError('Missing preprocessor report alongside gzip')
 if a.max_database_mb<1:raise ValueError('Database limit must be at least 1 MB')
 info=json.loads(meta.read_text(encoding='utf8'))
 if sha(src)!=info.get('output_sha256'):raise ValueError('Input does not match the preprocessing report SHA-256')
 dst.parent.mkdir(parents=True,exist_ok=True)
 fd,name=tempfile.mkstemp(prefix='.'+dst.name+'.',suffix='.partial',dir=dst.parent);os.close(fd);tmp=Path(name);c=None;complete=False
 try:
  c=sqlite3.connect(str(tmp));c.execute('PRAGMA page_size=4096');c.execute('PRAGMA journal_mode=OFF');c.execute('PRAGMA temp_store=FILE');c.execute('PRAGMA synchronous=OFF'); pages=int(a.max_database_mb*1_000_000)//4096;c.execute('PRAGMA max_page_count='+str(pages))
  c.execute('CREATE TABLE fixes(ts TEXT NOT NULL, mmsi TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, sog REAL, cog REAL, hdg REAL, mobile TEXT, ship_type TEXT, name TEXT, nav TEXT, sog_q TEXT, cog_q TEXT, hdg_q TEXT)')
  c.execute('CREATE INDEX fixes_time ON fixes(ts)')
  c.execute('CREATE INDEX fixes_vessel ON fixes(mmsi, ts)')
  c.execute('CREATE TABLE metadata(json TEXT NOT NULL)'); count=0;lo=None;hi=None
  with gzip.open(src,'rt',encoding='utf8',newline='') as f:
   r=csv.DictReader(f)
   if r.fieldnames!=FIELDS:raise ValueError('Unexpected normalized CSV fields')
   for row in r:
    ts=row['source_timestamp_utc']
    if not validtime(ts):raise ValueError('Unexpected timestamp in normalized CSV')
    def num(k):return None if row[k]=='' else float(row[k])
    rec=(ts,row['mmsi'],num('latitude_deg'),num('longitude_deg'),num('sog_knots'),num('cog_deg'),num('heading_deg'),row['mobile_type'],row['ship_type'],row['name'],row['navigational_status'],row['sog_quality'],row['cog_quality'],row['heading_quality'])
    c.execute('INSERT INTO fixes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',rec);count+=1
    lo=ts if lo is None or ts<lo else lo;hi=ts if hi is None or ts>hi else hi
    if count%10000==0:c.commit()
  if count==0:raise ValueError('No records matched the filter; database was not created')
  data={'records':count,'min_timestamp_utc':lo,'max_timestamp_utc':hi,'preprocessor_report':info,'source_data_sha256':info['output_sha256'],'database_limit_bytes':pages*4096,'availability':'simulated: source timestamp is treated as available at the same time, not proven live latency','dataset_type':'real or synthetic according to input; user must verify provenance','version':1}
  c.execute('INSERT INTO metadata VALUES (?)',(json.dumps(data),));c.commit()
  result=c.execute('PRAGMA integrity_check').fetchone()[0]
  if result!='ok':raise ValueError('SQLite integrity check failed: '+str(result))
  c.close();c=None
  os.link(tmp,dst);tmp.unlink();complete=True
  print(json.dumps({'database':str(dst),'database_bytes':dst.stat().st_size,'metadata':data},indent=2))
 finally:
  if c is not None:c.close()
  if not complete:tmp.unlink(missing_ok=True)

class Server(HTTPServer):
 allow_reuse_address=True
 def __init__(self,addr,db):super().__init__(addr,Handler);self.db=db
class Handler(BaseHTTPRequestHandler):
 protocol_version="HTTP/1.0"
 timeout=5
 def log_message(self,fmt,*args): pass
 def handle_one_request(self):
  try:
   super().handle_one_request()
  except (BrokenPipeError, ConnectionResetError):
   self.close_connection=True
 def sendjson(self,code,obj):
  try:
   b=json.dumps(obj,separators=(',',':'),allow_nan=False).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.send_header('Connection','close');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(b)
  except (BrokenPipeError, ConnectionResetError):
   self.close_connection=True
 def do_GET(self):
  # Reject DNS rebinding / external Host; no cross-origin headers or writes.
  if self.headers.get('Host')!=f'127.0.0.1:{self.server.server_port}':self.sendjson(403,{'error':'Forbidden host'});return
  p=urlparse(self.path)
  if p.path not in ['/health','/meta','/snapshot','/track','/datasets','/switch','/find-zips']:self.sendjson(404,{'error':'Not found'});return
  try:
   if p.path=='/health':self.sendjson(200,{'ok':True});return
   if p.path=='/find-zips':
    dl=Path.home()/'Downloads'; found_zips=[]
    if dl.is_dir():
     for f in sorted(dl.glob('*.zip'),key=lambda x:x.stat().st_mtime,reverse=True):
      if 'ais' in f.name.lower() or 'cable' in f.name.lower():
       found_zips.append({'name':f.name,'path':str(f),'size_mb':round(f.stat().st_size/1e6,1)})
    self.sendjson(200,{'zips':found_zips});return
   if p.path=='/datasets':
    work_dir=Path(__file__).resolve().parents[1]/'work'
    datasets=[]
    active_resolved=Path(self.server.db).resolve()
    if work_dir.is_dir():
     for dbf in sorted(work_dir.glob('*.sqlite'),key=lambda x:x.stat().st_mtime,reverse=True):
      try:
       c_tmp=sqlite3.connect(dbf.as_uri()+'?mode=ro',uri=True,timeout=2)
       try:
        raw_meta=c_tmp.execute('SELECT json FROM metadata').fetchone()[0]
        meta_obj=json.loads(raw_meta)
        datasets.append({
         'id':dbf.name,
         'path':str(dbf),
         'records':meta_obj.get('records',0),
         'min_timestamp_utc':meta_obj.get('min_timestamp_utc',''),
         'max_timestamp_utc':meta_obj.get('max_timestamp_utc',''),
         'input_file':meta_obj.get('preprocessor_report',{}).get('input_file',''),
         'bbox':meta_obj.get('preprocessor_report',{}).get('bbox_west_south_east_north',[]),
         'active':dbf.resolve()==active_resolved
        })
       finally:c_tmp.close()
      except Exception:pass
    self.sendjson(200,{'datasets':datasets,'active_db':str(self.server.db)});return
   if p.path=='/switch':
    q=parse_qs(p.query);target=q.get('db',[''])[0]
    if not target:raise ValueError('db parameter is required')
    work_dir=Path(__file__).resolve().parents[1]/'work'
    target_path=(work_dir/target if not os.path.isabs(target) else Path(target)).expanduser().resolve()
    if not target_path.is_file():raise ValueError('Database file does not exist: '+target)
    c_chk=sqlite3.connect(target_path.as_uri()+'?mode=ro',uri=True,timeout=3)
    try:
     meta_raw=c_chk.execute('SELECT json FROM metadata').fetchone()[0]
     c_chk.execute('SELECT 1 FROM fixes LIMIT 1')
     meta_json=json.loads(meta_raw)
    finally:c_chk.close()
    self.server.db=str(target_path)
    self.sendjson(200,{'ok':True,'active_db':str(target_path),'meta':meta_json});return
   uri=Path(self.server.db).as_uri()+'?mode=ro';c=sqlite3.connect(uri,uri=True,timeout=5)
   try:
    if p.path=='/meta':self.sendjson(200,json.loads(c.execute('SELECT json FROM metadata').fetchone()[0]));return
    if p.path=='/track':
     q=parse_qs(p.query);mmsi=q.get('mmsi',[''])[0];t=q.get('at',[''])[0];mins=int(q.get('window',['120'])[0]);lim=min(int(q.get('limit',['2000'])[0]),5000)
     if not re.fullmatch(r'[0-9]{9}',mmsi):raise ValueError('mmsi must be a 9-digit string')
     if not validtime(t) or not 1<=mins<=1440:raise ValueError('at must be YYYY-MM-DDTHH:MM:SSZ; window must be 1..1440 minutes')
     start=(dt.datetime.strptime(t,'%Y-%m-%dT%H:%M:%SZ')-dt.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%SZ')
     cur=c.execute('SELECT ts,mmsi,lat,lon,sog,cog,hdg,mobile,ship_type,name,nav,sog_q,cog_q,hdg_q,rowid FROM fixes WHERE mmsi=? AND ts>=? AND ts<=? ORDER BY ts ASC,rowid ASC LIMIT ?',(mmsi,start,t,lim+1))
     names=['timestamp','mmsi','lat','lon','sog','cog','heading','mobile_type','ship_type','name','navigational_status','sog_quality','cog_quality','heading_quality','rowid']
     track_fixes=[];scanned=0;truncated=False
     for row in cur:
      scanned+=1
      if scanned>lim:truncated=True;break
      track_fixes.append(dict(zip(names,row)))
     self.sendjson(200,{'mmsi':mmsi,'as_of':t,'window_minutes':mins,'fixes_count':len(track_fixes),'truncated':truncated,'limit':lim,'fixes':track_fixes})
     return
    q=parse_qs(p.query);t=q.get('at',[''])[0];mins=int(q.get('window',['60'])[0])
    if not validtime(t) or not 1<=mins<=1440:raise ValueError('at must be YYYY-MM-DDTHH:MM:SSZ; window must be 1..1440 minutes')
    start=(dt.datetime.strptime(t,'%Y-%m-%dT%H:%M:%SZ')-dt.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%SZ')
    cur=c.execute('SELECT ts,mmsi,lat,lon,sog,cog,hdg,mobile,ship_type,name,nav,sog_q,cog_q,hdg_q FROM fixes WHERE ts>=? AND ts<=? ORDER BY ts DESC,rowid DESC LIMIT 20001',(start,t)); found={};scanned=0;truncated=False
    names=['timestamp','mmsi','lat','lon','sog','cog','heading','mobile_type','ship_type','name','navigational_status','sog_quality','cog_quality','heading_quality']
    for row in cur:
     scanned+=1
     if scanned>20000:truncated=True;break
     if row[1] not in found:
      if len(found)>=500:truncated=True;break
      found[row[1]]=dict(zip(names,row))
    self.sendjson(200,{'as_of':t,'window_minutes':mins,'records_scanned':min(scanned,20000),'truncated':truncated,'limits':{'max_rows_scanned':20000,'max_vessels':500},'vessels':list(found.values()),'warning':'Latest visible point per MMSI within window; missing vessels are unknown, not absent. No live availability established.'})
   finally:c.close()
  except (ValueError,sqlite3.Error,TypeError) as e:self.sendjson(400,{'error':str(e)})

def serve(a):
 p=Path(a.database).expanduser().resolve()
 if not p.is_file():raise ValueError('Database file does not exist')
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
 try:c.execute('SELECT json FROM metadata').fetchone();c.execute('SELECT 1 FROM fixes LIMIT 1').fetchone()
 finally:c.close()
 s=Server(('127.0.0.1',a.port),str(p));print(f'Local read-only AIS service running at http://127.0.0.1:{a.port}; Ctrl-C to stop',flush=True)
 try:s.serve_forever()
 except KeyboardInterrupt:pass
 finally:s.server_close()

def main():
 p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='cmd',required=True)
 b=s.add_parser('build-db');b.add_argument('input');b.add_argument('--output',required=True);b.add_argument('--max-database-mb',type=float,default=200);b.set_defaults(fn=build)
 v=s.add_parser('serve');v.add_argument('database');v.add_argument('--port',type=int,default=8765);v.set_defaults(fn=serve)
 a=p.parse_args()
 try:a.fn(a)
 except (OSError,ValueError,sqlite3.Error,json.JSONDecodeError,csv.Error,KeyError,EOFError) as e:print('ERROR: '+str(e),file=sys.stderr);sys.exit(2)
if __name__=='__main__':main()
