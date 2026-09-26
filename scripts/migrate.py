"""Apply migrations as one D1 batch, preserving SQLite trigger bodies.

sqlite3.complete_statement preserves trigger bodies in a transactional batch.
Avoid SELECT CASE ... END; inside triggers: D1's HTTP statement splitter can
mistake that END for the end of the trigger. Use WHEN guards instead.
"""
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import tempfile

config = json.loads(pathlib.Path(os.environ.get('DEPLOYMENT_CONFIG', 'deployment.local.json' if pathlib.Path('deployment.local.json').exists() else 'deployment.json')).read_text())
database = config['worker']['env']['DB']['id']
os.environ['CLOUDFLARE_ACCOUNT_ID'] = config['accountId']
installed = pathlib.Path.home() / '.npm-global/bin/cf'
cf = os.environ.get('CF_BIN', str(installed) if installed.exists() else 'cf')

def query(sql):
    return json.loads(subprocess.check_output([cf, 'd1', 'query', database, '--sql', sql], text=True))

query('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)')
applied = {row['name'] for result in query('SELECT name FROM d1_migrations') for row in result['results']}
for path in sorted(pathlib.Path('migrations').glob('*.sql')):
    if path.name in applied:
        continue
    statements = []
    current = ''
    # Strip migration comments and normalize complete statements for the API.
    for char in re.sub(r'--[^\n]*', '', path.read_text()):
        current += char
        if char == ';' and sqlite3.complete_statement(current):
            statements.append({'sql': current.strip().replace('\n', ' ')})
            current = ''
    if current.strip():
        raise RuntimeError(f'Incomplete SQL in {path}')
    statements.append({'sql': 'INSERT INTO d1_migrations(name) VALUES (?)', 'params': [path.name]})
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as batch:
        json.dump(statements, batch)
        batch.flush()
        result = subprocess.run([cf, 'd1', 'query', database, '--batch', '@' + batch.name], text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
    print(f'Applied {path.name}')
