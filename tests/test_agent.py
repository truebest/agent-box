import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('agent', Path(__file__).parents[1] / 'agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class Client(unittest.TestCase):
    actor = {'actorTemplate': {'name': 'pi'}, 'status': {'state': 'ACTOR_STATE_RUNNING'}}

    def test_prompt_delivered_once_without_exec_or_wait(self):
        prompt = 'a "quote"; $(touch /tmp/unwanted)\n--wait'
        with patch.object(agent, 'Client') as client, patch('sys.argv', ['agent.py', 'pi-01', '--prompt', prompt]):
            client.return_value.request.side_effect = [self.actor, {'ready': True, 'kind': 'pi'}, {'accepted': True, 'message': 'Sent'}]
            self.assertEqual(agent.main(), 0)
            self.assertEqual(client.return_value.request.call_args_list[-1].args,
                             ('POST', '/api/agents/pi-01/prompt', {'prompt': prompt}))
            self.assertEqual(client.return_value.request.call_count, 3)

    def test_creation_options_and_defaults(self):
        for options, model, cwd in (([], 'gpt-6.1-sol', '/workspace'),
                                   (['--model', 'custom', '--cwd', '/workspace/project'], 'custom', '/workspace/project')):
            with patch.object(agent, 'Client') as client, patch('sys.argv', ['agent.py', 'pi-01', '--kind', 'pi', *options]):
                client.return_value.request.side_effect = [urllib.error.HTTPError('', 404, '', {}, None), self.actor, {'ready': True, 'kind': 'pi'}]
                self.assertEqual(agent.main(), 0)
                self.assertEqual(client.return_value.request.call_args_list[1].args[2],
                                 {'name': 'pi-01', 'kind': 'pi', 'model': model, 'cwd': cwd})

    def test_devin_default_model_and_setup_are_independent(self):
        with patch.object(agent, 'Client') as client, patch('sys.argv', ['agent.py', 'devin-01', '--kind', 'devin']):
            client.return_value.request.side_effect = [urllib.error.HTTPError('', 404, '', {}, None), self.actor,
                                                       {'ready': False, 'started': True, 'kind': 'devin'}]
            self.assertEqual(agent.main(), 0)
            self.assertEqual(client.return_value.request.call_args_list[1].args[2],
                             {'name': 'devin-01', 'kind': 'devin', 'model': '', 'cwd': '/workspace'})
            self.assertEqual(client.return_value.request.call_count, 3)

    def test_existing_options_cannot_be_changed(self):
        for option in (['--model', 'other'], ['--cwd', '/workspace/other']):
            with patch.object(agent, 'Client') as client, patch('sys.argv', ['agent.py', 'pi-01', *option, '--prompt', 'hello']):
                client.return_value.request.side_effect = [self.actor, {'ready': True, 'kind': 'pi', 'model': 'gpt-6.1-sol', 'cwd': '/workspace'}]
                with self.assertRaisesRegex(ValueError, 'Superterminal'):
                    agent.main()
                self.assertEqual(client.return_value.request.call_count, 2)

    def test_uncertain_submission_is_not_retried(self):
        with patch.object(agent, 'Client') as client, patch('sys.argv', ['agent.py', 'pi-01', '--prompt', 'hello']):
            client.return_value.request.side_effect = [self.actor, {'ready': True, 'kind': 'pi'}, OSError('Disconnected')]
            with self.assertRaises(OSError):
                agent.main()
            self.assertEqual(client.return_value.request.call_count, 3)

    def test_runtime_requests_pin_the_first_observed_uid(self):
        from unittest.mock import Mock
        client = object.__new__(agent.Client)
        client.url = 'https://panel.example'
        client.authorization = 'Basic example'
        client.actor_uids = {}
        client.opener = Mock()
        actor = lambda uid: {'metadata': {'name': 'sandbox', 'uid': uid}}
        client.opener.open.side_effect = [
            io.BytesIO(json.dumps(actor('selected')).encode()), io.BytesIO(b'{"ready":true}'),
            io.BytesIO(json.dumps(actor('replacement')).encode()), io.BytesIO(b'{"accepted":true}'),
        ]
        client.request('GET', '/api/agents/sandbox/session')
        client.request('GET', '/api/agents/sandbox')
        client.request('POST', '/api/agents/sandbox/prompt', {'prompt': 'hello'})
        self.assertEqual(client.runtime_path('/api/agents/sandbox/files?path=%2Fworkspace'),
                         '/api/agents/sandbox/files?path=%2Fworkspace&uid=selected')
        urls = [call.args[0].full_url for call in client.opener.open.call_args_list]
        self.assertEqual(urls, ['https://panel.example/api/agents/sandbox',
                               'https://panel.example/api/agents/sandbox/session?uid=selected',
                               'https://panel.example/api/agents/sandbox',
                               'https://panel.example/api/agents/sandbox/prompt?uid=selected'])


if __name__ == '__main__':
    unittest.main()
