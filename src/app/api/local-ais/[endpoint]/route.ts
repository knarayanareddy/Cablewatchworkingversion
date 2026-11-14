import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export const dynamic = 'force-dynamic';

const ALLOWED_GET = ['meta', 'snapshot', 'track', 'ml-score', 'datasets', 'switch', 'find-zips'];

export async function GET(req: NextRequest, ctx: { params: Promise<{ endpoint: string }> }) {
  const { endpoint } = await ctx.params;
  if (!ALLOWED_GET.includes(endpoint)) {
    return NextResponse.json({ error: 'Endpoint not allowed' }, { status: 404 });
  }

  const query = req.nextUrl.search;
  try {
    const upstream = await fetch(`http://127.0.0.1:8765/${endpoint}${query}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    const data = await upstream.json();
    return NextResponse.json(data, {
      status: upstream.status,
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch {
    return NextResponse.json(
      { error: 'Local AIS Python service unavailable. Ensure it is running on 127.0.0.1:8765.' },
      { status: 503 }
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ endpoint: string }> }) {
  const { endpoint } = await ctx.params;
  if (endpoint !== 'ingest') {
    return NextResponse.json({ error: 'Endpoint not allowed' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { zip_path, preset = 'baltic', bbox, max_rows = 1000000, name, force = false } = body;

    if (!zip_path) {
      return NextResponse.json({ error: 'zip_path is required' }, { status: 400 });
    }

    if (name && !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      return NextResponse.json(
        { error: 'Invalid name. Name must be 1-64 alphanumeric, dash, or underscore characters without paths.' },
        { status: 400 }
      );
    }

    const scriptPath = path.resolve(process.cwd(), 'python/pipeline.py');
    const args = [scriptPath, zip_path, '--max-rows', String(max_rows)];
    if (bbox && Array.isArray(bbox) && bbox.length === 4) {
      args.push('--bbox', ...bbox.map(String));
    } else if (preset) {
      args.push('--preset', preset);
    }
    if (name) {
      args.push('--name', name);
    }
    if (force) {
      args.push('--force');
    }

    return await new Promise<NextResponse>((resolve) => {
      const proc = spawn('python3', args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(
            NextResponse.json({
              ok: true,
              message: 'Dataset successfully ingested and activated!',
              log: stdout
            })
          );
        } else {
          resolve(
            NextResponse.json(
              {
                error: 'Ingestion failed',
                details: stderr || stdout
              },
              { status: 500 }
            )
          );
        }
      });

      proc.on('error', (err) => {
        resolve(
          NextResponse.json(
            { error: 'Failed to launch ingestion process', details: err.message },
            { status: 500 }
          )
        );
      });
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
