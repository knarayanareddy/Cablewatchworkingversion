import csv,gzip,json,subprocess,sys,tempfile,unittest,zipfile
from pathlib import Path
TOOL=Path(__file__).resolve().parents[1]/'python'/'ais_preprocess.py'
HEADER='# Timestamp,Type of mobile,MMSI,Latitude,Longitude,SOG,COG,Heading,Name,Ship type,Navigational status\n'
ROWS=[
'11/09/2026 12:00:00,Class A,219063000,55.2,14.1,6.4,216.9,217,EXAMPLE,Cargo,Under way',
'11/09/2026 12:01:00,Class B,219063001,55.3,14.2,102.3,360,511,,,',
'11/09/2026 12:02:00,Class B,219063001,55.3,14.2,102.2,1,0,EXAMPLE,,',
'11/09/2026 12:03:00,Class A,219063000,91,14.1,2,10,10,,,',
'11/09/2026 12:04:00,Base Station,001234567,55.2,14.1,2,10,10,,,',
'bad,Class A,219063000,55.2,14.1,2,10,10,,,',
'11/09/2026 12:06:00,Class A,123,55.2,14.1,2,10,10,,,',
'11/09/2026 12:07:00,Class A,219063000,60,14.1,2,10,10,,,',
'11/09/2026 12:08:00,Class A,219063000,55.2,14.1,NaN,-1,361,,,',
]
class Smoke(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(); self.p=Path(self.t.name);self.z=self.p/'ais.zip'
  with zipfile.ZipFile(self.z,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('sample.csv',HEADER+'\n'.join(ROWS)+'\n')
 def tearDown(self): self.t.cleanup()
 def cli(self,*args,code=0):
  p=subprocess.run([sys.executable,str(TOOL),*map(str,args)],capture_output=True,text=True)
  self.assertEqual(p.returncode,code,p.stdout+'\n'+p.stderr);return p
 def runfile(self,out,*args,code=0):return self.cli('run',self.z,'--output',out,'--bbox',10,54,16,56,'--assume-utc',*args,code=code)
 def test_inspect(self):
  p=self.cli('inspect',self.z);self.assertIn('"timestamp": "# Timestamp"',p.stdout);self.assertNotIn('219063000',p.stdout)
 def test_normalize_and_reject(self):
  out=self.p/'filtered.csv.gz';self.runfile(out)
  with gzip.open(out,'rt',newline='') as f: rows=list(csv.DictReader(f))
  rep=json.loads(Path(str(out)+'.report.json').read_text());c=rep['counts']
  self.assertEqual(c['rows_read'],9);self.assertEqual(c['rows_written'],4)
  for k in ['rejected_non_class_a_b','rejected_bad_timestamp','rejected_bad_mmsi','rejected_invalid_position','rejected_outside_bbox']:self.assertEqual(c[k],1)
  self.assertEqual(rows[0]['source_timestamp_utc'],'2026-09-11T12:00:00Z')
  self.assertEqual((rows[1]['sog_knots'],rows[1]['cog_deg'],rows[1]['heading_deg']),('','',''))
  self.assertEqual(rows[1]['heading_quality'],'unavailable');self.assertEqual(rows[2]['sog_quality'],'saturated_lower_bound')
  self.assertEqual((rows[3]['sog_quality'],rows[3]['cog_quality'],rows[3]['heading_quality']),('invalid','invalid','invalid'))
  self.assertIsNone(rep['input_sha256']);self.assertFalse(rep['deduplicated'])
  self.runfile(out,code=2)
 def test_sampling(self):
  out=self.p/'sample.csv.gz';self.runfile(out,'--max-rows',2)
  r=json.loads(Path(str(out)+'.report.json').read_text());self.assertEqual(r['counts']['rows_read'],2);self.assertTrue(r['truncated_by_row_limit'])
 def test_cap_cleanup(self):
  out=self.p/'small.csv.gz';self.runfile(out,'--max-output-mb','0.00001',code=2)
  self.assertFalse(out.exists());self.assertFalse(Path(str(out)+'.report.json').exists());self.assertEqual(list(self.p.glob('*.partial')),[])
 def test_wrong_header_and_multiple_members(self):
  z=self.p/'bad.zip'
  with zipfile.ZipFile(z,'w') as f:f.writestr('a.csv','hello,world\n1,2\n');f.writestr('b.csv','hello,world\n')
  self.cli('inspect',z,code=2);self.cli('inspect',z,'--member','a.csv',code=2)
 def test_timezone_acknowledgment_required(self):
  self.cli('run',self.z,'--output',self.p/'z.csv.gz','--bbox',10,54,16,56,code=2)
if __name__=='__main__':unittest.main()
