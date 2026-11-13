from pathlib import Path
import zipfile
p=Path(__file__).resolve().parents[1]/'fixtures'/'synthetic-danish-ais.zip'
header='# Timestamp,Type of mobile,MMSI,Latitude,Longitude,SOG,COG,Heading,Name,Ship type,Navigational status\n'
rows=[
 '13/01/2026 12:00:00,Class A,219000001,55.0000,14.0000,5.0,90,90,SYNTHETIC ONE,Cargo,Under way',
 '13/01/2026 12:05:00,Class A,219000001,55.0100,14.0100,4.0,90,511,SYNTHETIC ONE,Cargo,Under way',
 '13/01/2026 12:07:00,Class B,219000002,55.0200,14.0200,102.3,360,511,SYNTHETIC TWO,Unknown,Unknown',
 '13/01/2026 12:10:00,Class A,219000001,55.1000,14.1000,7.0,90,90,SYNTHETIC ONE,Cargo,Under way',
 '13/01/2026 12:11:00,Class A,219000003,91,14.0000,1,1,1,BAD POSITION,Unknown,Unknown',
 '13/01/2026 12:12:00,Base Station,123456789,55.0000,14.0000,1,1,1,NOT VESSEL,Unknown,Unknown',
]
with zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('synthetic.csv',header+'\n'.join(rows)+'\n')
print(p)
