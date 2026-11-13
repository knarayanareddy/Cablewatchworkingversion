#!/usr/bin/env python3
"""Stream a headered, comma-delimited Danish AIS CSV from a ZIP into normalized CSV.gz."""
import argparse, csv, datetime as dt, gzip, hashlib, io, json, math, os, re, sys, tempfile, zipfile
from collections import Counter
from pathlib import Path

VERSION='0.1.0'
FIELDS=['source_timestamp_utc','mmsi','latitude_deg','longitude_deg','sog_knots','cog_deg','heading_deg','mobile_type','ship_type','name','navigational_status','sog_quality','cog_quality','heading_quality']
ALIASES={'timestamp':['timestamp'], 'mmsi':['mmsi'], 'lat':['latitude','lat'], 'lon':['longitude','lon','lng'], 'mobile':['typeofmobile','mobiletype'], 'sog':['sog','speedoverground'], 'cog':['cog','courseoverground'], 'heading':['heading','trueheading'], 'type':['shiptype','vesseltype'], 'name':['name','vesselname'], 'nav':['navigationalstatus','navstatus']}
REQUIRED=['timestamp','mmsi','lat','lon']

def key(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower().lstrip('\ufeff'))
def map_header(names):
    if not names: raise ValueError('CSV has no header')
    ns=[key(s) for s in names]
    if len(set(ns))!=len(ns): raise ValueError('Duplicate or ambiguous normalized column names')
    result={}
    for field, aliases in ALIASES.items():
        matches=[i for i,n in enumerate(ns) if n in aliases]
        if len(matches)>1: raise ValueError('Ambiguous aliases for '+field)
        if matches: result[field]=names[matches[0]]
    missing=[f for f in REQUIRED if f not in result]
    if missing: raise ValueError('Missing required header fields: '+', '.join(missing))
    return result

def value(row,m,k): return (row.get(m[k]) or '').strip() if k in m else ''
def number(s):
    try:
        v=float(s)
        return v if math.isfinite(v) else None
    except (ValueError,TypeError): return None

def timestamp(s):
    # Explicitly requested assumption: archive timestamps are UTC, pending source confirmation.
    try: return dt.datetime.strptime(s,'%d/%m/%Y %H:%M:%S').replace(tzinfo=dt.timezone.utc).isoformat().replace('+00:00','Z')
    except ValueError: return None

def optional(s,kind):
    if s.lower() in ('','unknown','undefined','n/a','null','none'): return '', 'missing'
    n=number(s)
    if n is None: return '', 'invalid'
    if kind=='sog':
        if abs(n-102.3)<1e-8: return '', 'unavailable'
        if n<0 or n>102.2: return '', 'invalid'
        if abs(n-102.2)<1e-8: return format(n,'.10g'), 'saturated_lower_bound'
    elif kind=='cog':
        if abs(n-360)<1e-8: return '', 'unavailable'
        if not 0<=n<360: return '', 'invalid'
    else:
        if n==511: return '', 'unavailable'
        if not 0<=n<360 or n!=int(n): return '', 'invalid'
    return format(n,'.10g'), 'valid'

def select_member(z, selected=None):
    files=[x for x in z.infolist() if not x.is_dir() and x.filename.lower().endswith('.csv')]
    if selected:
        files=[x for x in files if x.filename==selected]
        if len(files)!=1: raise ValueError('Selected member not found uniquely: '+selected)
    elif len(files)!=1: raise ValueError('ZIP must contain exactly one CSV, or use --member. Found: '+', '.join(x.filename for x in files[:20]))
    if files[0].flag_bits & 1: raise ValueError('Encrypted ZIP entries are not supported')
    return files[0]

def open_csv(z, info):
    return io.TextIOWrapper(z.open(info),'utf-8-sig',newline='',errors='strict')

def inspect(args):
    with zipfile.ZipFile(args.zip) as z:
        for i in z.infolist(): print(f'{i.filename}\tcompressed={i.compress_size}\tuncompressed={i.file_size}')
        info=select_member(z,args.member)
        with open_csv(z,info) as f:
            r=csv.DictReader(f); mapping=map_header(r.fieldnames)
            print('\nHeaders:',json.dumps(r.fieldnames,ensure_ascii=False))
            print('Mapped:',json.dumps(mapping,ensure_ascii=False,indent=2))
            print('Optional absent:',', '.join(k for k in ALIASES if k not in REQUIRED and k not in mapping) or 'none')
            print('No AIS rows printed. Timestamp timezone and units must be confirmed against the provider.')

def sha256(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(4*1024*1024),b''): h.update(b)
    return h.hexdigest()

def run(args):
    out=Path(args.output).expanduser().resolve(); report=Path(str(out)+'.report.json')
    src=Path(args.zip).expanduser().resolve()
    if out==src or report==src: raise ValueError('Output and input must be different files')
    if out.exists() or report.exists(): raise ValueError('Output or report already exists; choose a new output path')
    if not out.name.endswith('.csv.gz'): raise ValueError('Output must end in .csv.gz')
    if args.max_output_mb <= 0: raise ValueError('max output must be positive')
    # Bbox order is explicit: west south east north.
    west,south,east,north=args.bbox
    if not (-180<=west<east<=180 and -90<=south<north<=90): raise ValueError('Invalid bounding box: west south east north (no antimeridian crossing)')
    limit=int(args.max_output_mb*1_000_000)
    out.parent.mkdir(parents=True,exist_ok=True)
    fd,tmpname=tempfile.mkstemp(prefix='.'+out.name+'.',suffix='.partial',dir=out.parent);os.close(fd)
    tmp=Path(tmpname); counts=Counter(); warn=Counter(); min_t=None; max_t=None; committed=False
    try:
        with zipfile.ZipFile(src) as z:
            info=select_member(z,args.member)
            if info.file_size>args.max_input_gb*1_000_000_000: raise ValueError('Uncompressed member exceeds safety limit; inspect file and raise --max-input-gb deliberately')
            with open_csv(z,info) as inf, open(tmp,'wb') as raw:
                reader=csv.DictReader(inf); mapping=map_header(reader.fieldnames)
                # gzip and text wrappers remain open on each iteration; raw.tell checks compressed size.
                with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as gz, io.TextIOWrapper(gz,encoding='utf-8',newline='') as text:
                    writer=csv.DictWriter(text,fieldnames=FIELDS,lineterminator='\n');writer.writeheader()
                    for row in reader:
                        if args.max_rows and counts['rows_read']>=args.max_rows:
                            counts['stopped_at_row_limit']=1; break
                        counts['rows_read']+=1
                        if None in row: counts['rejected_extra_columns']+=1; continue
                        mob=value(row,mapping,'mobile')
                        if 'mobile' in mapping and mob.lower() not in ('class a','class b'):
                            counts['rejected_non_class_a_b']+=1; continue
                        ts=timestamp(value(row,mapping,'timestamp'))
                        if ts is None: counts['rejected_bad_timestamp']+=1; continue
                        mmsi=value(row,mapping,'mmsi')
                        if not re.fullmatch(r'[0-9]{9}',mmsi) or mmsi=='000000000': counts['rejected_bad_mmsi']+=1; continue
                        lat=number(value(row,mapping,'lat'));lon=number(value(row,mapping,'lon'))
                        if lat is None or lon is None or not -90<=lat<=90 or not -180<=lon<=180:
                            counts['rejected_invalid_position']+=1;continue
                        if not (west<=lon<=east and south<=lat<=north): counts['rejected_outside_bbox']+=1;continue
                        sog,sq=optional(value(row,mapping,'sog'),'sog');cog,cq=optional(value(row,mapping,'cog'),'cog');hdg,hq=optional(value(row,mapping,'heading'),'heading')
                        for kind,qual in [('sog',sq),('cog',cq),('heading',hq)]: warn[kind+'_'+qual]+=1
                        record={'source_timestamp_utc':ts,'mmsi':mmsi,'latitude_deg':format(lat,'.10g'),'longitude_deg':format(lon,'.10g'),'sog_knots':sog,'cog_deg':cog,'heading_deg':hdg,'mobile_type':mob,'ship_type':value(row,mapping,'type'),'name':value(row,mapping,'name'),'navigational_status':value(row,mapping,'nav'),'sog_quality':sq,'cog_quality':cq,'heading_quality':hq}
                        writer.writerow(record);counts['rows_written']+=1
                        min_t=ts if min_t is None or ts<min_t else min_t;max_t=ts if max_t is None or ts>max_t else max_t
                        if counts['rows_written']%2000==0:
                            text.flush()
                            if raw.tell()>limit: raise ValueError('Compressed output exceeded configured limit; no final output created. Narrow bounding box or increase cap.')
                    text.flush()
                size=raw.tell()
                if size>limit: raise ValueError('Compressed output exceeded configured limit; no final output created. Narrow bounding box or increase cap.')
        result={'tool_version':VERSION,'input_file':src.name,'zip_member':info.filename,'zip_member_uncompressed_bytes':info.file_size,'input_zip_bytes':src.stat().st_size,'input_sha256':sha256(src) if args.hash_input else None,'timestamp_interpretation':'Source timestamps interpreted as UTC by explicit user assumption; verify with provider. This is NOT proof of live availability.','timestamp_source_format':'DD/MM/YYYY HH:MM:SS','bbox_west_south_east_north':[west,south,east,north],'mobile_filter':'Class A and Class B when mobile column exists; otherwise no mobile-type filter','column_mapping':mapping,'counts':dict(counts),'optional_field_quality_counts':dict(warn),'min_source_timestamp_utc':min_t,'max_source_timestamp_utc':max_t,'output_compressed_bytes':size,'output_sha256':sha256(tmp),'size_cap_bytes':limit,'truncated_by_row_limit':bool(counts['stopped_at_row_limit']),'deduplicated':False,'sorted':False,'availability_time':'not supplied; no live-arrival time inferred','status':'normalized data only; NOT a Cable Watch file and not validated for operational use'}
        # Create report first with exclusive mode; data is committed only after successful report write.
        with open(report,'x',encoding='utf-8') as f: json.dump(result,f,indent=2,ensure_ascii=False);f.write('\n')
        try:
            os.link(tmp,out)  # fail if destination appeared during processing
            tmp.unlink();committed=True
        except Exception:
            report.unlink(missing_ok=True);raise
        print(json.dumps(result,indent=2))
    finally:
        if not committed: tmp.unlink(missing_ok=True)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--version',action='version',version=VERSION); sub=p.add_subparsers(dest='cmd',required=True)
    i=sub.add_parser('inspect');i.add_argument('zip');i.add_argument('--member');i.set_defaults(func=inspect)
    r=sub.add_parser('run');r.add_argument('zip');r.add_argument('--member');r.add_argument('--output',required=True);r.add_argument('--bbox',type=float,nargs=4,required=True,metavar=('WEST','SOUTH','EAST','NORTH'));r.add_argument('--assume-utc',required=True,action='store_true',help='Explicitly assume naive source timestamps are UTC; verify with provider');r.add_argument('--max-output-mb',type=float,default=100,help='Decimal MB of compressed CSV output (default 100); excludes input ZIP and JSON report');r.add_argument('--max-input-gb',type=float,default=15,help='Maximum advertised uncompressed CSV size in decimal GB (default 15)');r.add_argument('--max-rows',type=int,default=0,help='Input row sample limit; 0 means all');r.add_argument('--hash-input',action='store_true',help='Read ZIP one extra time to record SHA256');r.set_defaults(func=run)
    args=p.parse_args()
    try:
        if getattr(args,'max_rows',0)<0: raise ValueError('max rows cannot be negative')
        if getattr(args,'max_input_gb',1)<=0: raise ValueError('max input GB must be positive')
        args.func(args)
    except (OSError,ValueError,zipfile.BadZipFile,UnicodeError,csv.Error) as e:
        print('ERROR: '+str(e),file=sys.stderr);sys.exit(2)
if __name__=='__main__': main()
