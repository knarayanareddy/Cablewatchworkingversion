import importlib.util,json,subprocess,sys,tempfile,threading,unittest,urllib.error,urllib.request,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; NORM=ROOT/'python/ais_preprocess.py'; DB=ROOT/'python/local_ais.py'; PIPE=ROOT/'python/pipeline.py'; FIX=ROOT/'fixtures/synthetic-danish-ais.zip'
spec=importlib.util.spec_from_file_location('local_ais',DB);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Pipeline(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.d=Path(self.tmp.name);self.gz=self.d/'subset.csv.gz';self.db=self.d/'test.sqlite'
  self.runok(NORM,'run',FIX,'--output',self.gz,'--bbox',13.9,54.9,14.2,55.2,'--assume-utc','--max-output-mb',10)
 def tearDown(self):self.tmp.cleanup()
 def runok(self,*a):
  r=subprocess.run([sys.executable,*map(str,a)],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stdout+r.stderr);return r
 def test_zip_to_sqlite_and_bounded_snapshot(self):
  self.runok(DB,'build-db',self.gz,'--output',self.db,'--max-database-mb',2)
  s=mod.Server(('127.0.0.1',0),str(self.db));t=threading.Thread(target=s.serve_forever,daemon=True);t.start();base=f'http://127.0.0.1:{s.server_port}'
  try:
   def get(path):
    with urllib.request.urlopen(base+path) as r:return json.load(r)
   self.assertEqual(get('/meta')['records'],4)
   first=get('/snapshot?at=2026-01-13T12%3A00%3A00Z&window=60');self.assertEqual(len(first['vessels']),1);self.assertEqual(first['vessels'][0]['timestamp'],'2026-01-13T12:00:00Z')
   middle=get('/snapshot?at=2026-01-13T12%3A07%3A00Z&window=60');self.assertEqual(len(middle['vessels']),2)
   one=next(x for x in middle['vessels'] if x['mmsi']=='219000001');two=next(x for x in middle['vessels'] if x['mmsi']=='219000002');self.assertEqual(one['timestamp'],'2026-01-13T12:05:00Z');self.assertIsNone(one['heading']);self.assertIsNone(two['sog'])
   self.assertEqual(get('/snapshot?at=2026-01-13T12%3A10%3A00Z&window=1')['vessels'][0]['timestamp'],'2026-01-13T12:10:00Z')
   with self.assertRaises(urllib.error.HTTPError):get('/snapshot?at=not-a-time&window=60')
   req=urllib.request.Request(base+'/meta',headers={'Host':'attacker.example'});
   with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(req)
   self.assertEqual(e.exception.code,403)
  finally:s.shutdown();s.server_close();t.join()
 def test_limits_and_database_failure_cleanup(self):
  source=self.d/'big.zip'; output=self.d/'big.csv.gz'; small=self.d/'small.sqlite'; large=self.d/'large.sqlite'
  header='# Timestamp,Type of mobile,MMSI,Latitude,Longitude,SOG,COG,Heading,Name,Ship type,Navigational status\n'
  with zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED) as z:
   with z.open('big.csv','w') as w:
    w.write(header.encode())
    for i in range(20000):w.write(f'13/01/2026 12:00:00,Class A,{200000000+i},55,14,5,90,90,EXAMPLE,Cargo,Under way\n'.encode())
  self.runok(NORM,'run',source,'--output',output,'--bbox',13.9,54.9,14.2,55.2,'--assume-utc','--max-output-mb',10)
  r=subprocess.run([sys.executable,str(DB),'build-db',str(output),'--output',str(small),'--max-database-mb','1'],capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0);self.assertFalse(small.exists());self.assertFalse(list(self.d.glob('*.partial')))
  self.runok(DB,'build-db',output,'--output',large,'--max-database-mb',10)
  server=mod.Server(('127.0.0.1',0),str(large));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/snapshot?at=2026-01-13T12%3A00%3A00Z&window=60') as resp:data=json.load(resp)
   self.assertEqual(len(data['vessels']),500);self.assertTrue(data['truncated'])
  finally:server.shutdown();server.server_close();thread.join()
 def test_modified_file_is_rejected(self):
  with self.gz.open('ab') as f:f.write(b'not-original')
  r=subprocess.run([sys.executable,str(DB),'build-db',str(self.gz),'--output',str(self.db)],capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0);self.assertIn('SHA-256',r.stderr);self.assertFalse(self.db.exists())
 def test_pipeline_output_safety_and_name_constraint(self):
  r=subprocess.run([sys.executable,str(PIPE),str(FIX),'--name','../bad_path'],capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0)
  self.assertIn('Invalid output name',r.stderr+r.stdout)
  name='test_safe_run'
  r1=subprocess.run([sys.executable,str(PIPE),str(FIX),'--name',name,'--no-switch','--preset','bornholm','--max-rows','100'],capture_output=True,text=True)
  self.assertEqual(r1.returncode,0,r1.stdout+r1.stderr)
  r2=subprocess.run([sys.executable,str(PIPE),str(FIX),'--name',name,'--no-switch','--preset','bornholm','--max-rows','100'],capture_output=True,text=True)
  self.assertNotEqual(r2.returncode,0)
  self.assertIn('already exists',r2.stderr+r2.stdout)
  r3=subprocess.run([sys.executable,str(PIPE),str(FIX),'--name',name,'--no-switch','--preset','bornholm','--max-rows','100','--force'],capture_output=True,text=True)
  self.assertEqual(r3.returncode,0,r3.stdout+r3.stderr)
  for ext in ('.csv.gz','.sqlite','.csv.gz.report.json'):
   (ROOT/'work'/f'{name}{ext}').unlink(missing_ok=True)
 def test_force_overwrite_preserves_sentinels_on_failure(self):
  name='sentinel_test'
  work=ROOT/'work'
  work.mkdir(parents=True,exist_ok=True)
  f_csv=work/f'{name}.csv.gz'; f_sql=work/f'{name}.sqlite'; f_rep=work/f'{name}.csv.gz.report.json'
  try:
   f_csv.write_bytes(b'sentinel_csv'); f_sql.write_bytes(b'sentinel_sql'); f_rep.write_bytes(b'{"sentinel":true}')
   bad_zip=self.d/'corrupt.zip'; bad_zip.write_bytes(b'not a real zip file')
   r=subprocess.run([sys.executable,str(PIPE),str(bad_zip),'--name',name,'--force'],capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0)
   self.assertTrue(f_csv.exists(),'Original csv.gz must be preserved on failure')
   self.assertTrue(f_sql.exists(),'Original sqlite must be preserved on failure')
   self.assertTrue(f_rep.exists(),'Original report must be preserved on failure')
   self.assertEqual(f_csv.read_bytes(),b'sentinel_csv')
   self.assertEqual(f_sql.read_bytes(),b'sentinel_sql')
  finally:
   f_csv.unlink(missing_ok=True); f_sql.unlink(missing_ok=True); f_rep.unlink(missing_ok=True)
 def test_explicit_bbox_precedence_over_preset(self):
  name='bbox_precedence_test'
  work=ROOT/'work'
  f_rep=work/f'{name}.csv.gz.report.json'
  try:
   # Pass BOTH preset (baltic) AND explicit bbox (custom coordinates)
   r=subprocess.run([sys.executable,str(PIPE),str(FIX),'--name',name,'--preset','baltic','--bbox','13.5','54.5','16.0','56.0','--no-switch','--max-rows','100','--force'],capture_output=True,text=True)
   self.assertEqual(r.returncode,0,r.stdout+r.stderr)
   self.assertTrue(f_rep.exists())
   with f_rep.open() as f:data=json.load(f)
   self.assertEqual(data['bbox_west_south_east_north'],[13.5,54.5,16.0,56.0],'Explicit --bbox must take strict precedence over --preset')
  finally:
   for ext in ('.csv.gz','.sqlite','.csv.gz.report.json'):
    (work/f'{name}{ext}').unlink(missing_ok=True)
if __name__=='__main__':unittest.main()
