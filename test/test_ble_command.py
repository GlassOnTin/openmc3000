import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ble_command", Path(__file__).parent.parent / "bridge" / "ble_command.py")
ble = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ble)


class FakeClient:
    writes = []
    status = 0
    voltage = 1280
    acknowledge = True

    def __init__(self, address, timeout):
        self.address = address

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def start_notify(self, characteristic, callback):
        self.callback = callback

    async def write_gatt_char(self, characteristic, data, response):
        self.writes.append(bytes(data))
        opcode, value = data[1:3]
        if opcode == 5 and self.acknowledge:
            type(self).status = 1
        if opcode == 0xFE and self.acknowledge:
            type(self).status = 0
        reply = ble.frame(opcode, value)
        if opcode == 0x55:
            reply[6] = self.status
            reply[9:11] = self.voltage.to_bytes(2, "big")
            reply[19] = sum(reply[:19]) & 255
        self.callback(None, reply)


class CommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeClient.writes = []
        FakeClient.status = 0
        FakeClient.voltage = 1280
        FakeClient.acknowledge = True
        self.bleak = patch.dict(sys.modules, {"bleak": types.SimpleNamespace(BleakClient=FakeClient)})
        self.bleak.start()
        self.sleep = patch.object(ble.asyncio, "sleep", return_value=None)
        self.sleep.start()

    async def asyncTearDown(self):
        self.sleep.stop()
        self.bleak.stop()

    async def test_start_uses_one_slot_mask_and_verifies_state(self):
        await ble.execute("AA:BB:CC:DD:EE:FF", 3, True)
        self.assertEqual([(p[1], p[2]) for p in FakeClient.writes], [(0x55, 2), (5, 4), (0x55, 2)])
        self.assertTrue(all(sum(p[:19]) & 255 == p[19] for p in FakeClient.writes))

    async def test_start_rejects_empty_slot(self):
        FakeClient.voltage = 0
        with self.assertRaisesRegex(RuntimeError, "not idle"):
            await ble.execute("AA:BB:CC:DD:EE:FF", 1, True)
        self.assertEqual([p[1] for p in FakeClient.writes], [0x55])

    async def test_ack_without_running_is_not_success(self):
        FakeClient.acknowledge = False
        with self.assertRaisesRegex(RuntimeError, "acknowledged"):
            await ble.execute("AA:BB:CC:DD:EE:FF", 1, True)

    async def test_stop_does_not_send_start(self):
        FakeClient.status = 1
        await ble.execute("AA:BB:CC:DD:EE:FF", 4, False)
        self.assertEqual([(p[1], p[2]) for p in FakeClient.writes], [(0xFE, 8), (0x55, 3)])


if __name__ == "__main__":
    unittest.main()
