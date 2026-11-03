import io
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from lululian.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        yield client


def create(client):
    result = client.post('/api/projects', json={'title': '测试短剧', 'premise': '年轻店主收到一封来自明天的信。'})
    assert result.status_code == 201
    return result.json()


def run_job(client, pid, kind, **extra):
    response = client.post(f'/api/projects/{pid}/jobs', json={'kind': kind, **extra})
    assert response.status_code == 202, response.text
    jid = response.json()['id']
    for _ in range(600):
        job = next(j for j in client.get(f'/api/projects/{pid}/jobs').json() if j['id'] == jid)
        if job['status'] in ('succeeded', 'failed'):
            return job
        time.sleep(.1)
    pytest.fail('job timed out')


def test_project_validation_and_revision_conflict(client):
    assert client.post('/api/projects', json={'title': '', 'premise': 'x'}).status_code == 422
    record = create(client)
    body = {'revision': record['revision'], 'document': record['document']}
    body['document']['title'] = '新标题'
    assert client.put(f"/api/projects/{record['id']}", json=body).status_code == 200
    assert client.put(f"/api/projects/{record['id']}", json=body).status_code == 409


def test_demo_judge_gate_and_asset_checkpoint(client):
    pid = create(client)['id']
    assert run_job(client, pid, 'script')['status'] == 'succeeded'
    assert client.post(f'/api/projects/{pid}/jobs', json={'kind': 'images'}).status_code == 409
    review = run_job(client, pid, 'judge')
    assert review['result']['source'] == 'rules'
    assert review['result']['score'] is None
    assert client.post(f'/api/projects/{pid}/approve').status_code == 200
    assert run_job(client, pid, 'images')['status'] == 'succeeded'
    record = client.get(f'/api/projects/{pid}').json()
    assert all(s['image'] for e in record['document']['episodes'] for s in e['shots'])
    record['document']['episodes'][0]['shots'][0]['visual'] = '完全不同的画面'
    assert client.put(f'/api/projects/{pid}', json={k: record[k] for k in ('revision', 'document')}).status_code == 200
    assert client.post(f'/api/projects/{pid}/approve').status_code == 409
    assert client.post(f'/api/projects/{pid}/jobs', json={'kind': 'images'}).status_code == 409


def test_settings_never_return_secrets(client):
    settings = client.get('/api/settings').json()
    for kind in ('text', 'image', 'voice', 'judge'):
        settings[kind].pop('configured')
    settings['text']['api_key'] = 'test-secret-only'
    result = client.put('/api/settings', json=settings)
    assert result.status_code == 200
    assert 'test-secret-only' not in result.text
    assert result.json()['text']['configured']
    settings['text']['api_key'] = ''
    assert client.put('/api/settings', json=settings).json()['text']['configured']


def test_upload_lock_and_media_boundary(client):
    pid = create(client)['id']
    run_job(client, pid, 'script')
    record = client.get(f'/api/projects/{pid}').json()
    shot = record['document']['episodes'][0]['shots'][0]
    image = io.BytesIO()
    Image.new('RGB', (32, 32)).save(image, 'PNG')
    path = f"/api/projects/{pid}/shots/{shot['id']}/upload/image"
    response = client.post(path, files={'file': ('image.png', image.getvalue(), 'image/png')})
    assert response.status_code == 200
    record = response.json()
    shot = record['document']['episodes'][0]['shots'][0]
    assert client.get(f"/media/{pid}/{shot['image']}").status_code == 200
    shot['locked'] = True
    client.put(f'/api/projects/{pid}', json={k: record[k] for k in ('revision', 'document')})
    assert client.post(path, files={'file': ('image.png', image.getvalue(), 'image/png')}).status_code == 409
    assert client.get(f'/media/{pid}/settings.json').status_code == 404
    assert client.post('/api/projects', headers={'Origin': 'https://untrusted.example'}, json={}).status_code == 403


def test_real_mp4_render(client):
    import shutil

    from lululian.render import probe

    if not shutil.which('ffmpeg'):
        pytest.skip('FFmpeg is not installed')
    pid = create(client)['id']
    run_job(client, pid, 'script')
    record = client.get(f'/api/projects/{pid}').json()
    record['document']['episodes'][0]['shots'] = record['document']['episodes'][0]['shots'][:2]
    for shot in record['document']['episodes'][0]['shots']:
        shot['duration'] = 1
        shot['narration'] = '测试字幕'
    client.put(f'/api/projects/{pid}', json={k: record[k] for k in ('revision', 'document')})
    run_job(client, pid, 'judge')
    client.post(f'/api/projects/{pid}/approve')
    run_job(client, pid, 'images')
    job = run_job(client, pid, 'render', episode_id=record['document']['episodes'][0]['id'])
    assert job['status'] == 'succeeded', job['message']
    filename = job['result']['video']
    metadata = probe(client.app.state.store.media / pid / filename)
    assert any(s['codec_name'] == 'h264' for s in metadata['streams'])
    assert abs(float(metadata['format']['duration']) - 2) < .2
    assert client.get(f'/media/{pid}/{filename}').status_code == 200
