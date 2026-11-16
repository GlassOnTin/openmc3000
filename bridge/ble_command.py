"""Send one MC3000 slot command over Bluetooth LE."""

import argparse
import asyncio

CHARACTERISTIC = "0000ffe1-0000-1000-8000-00805f9b34fb"


def frame(opcode, payload):
    data = bytearray(20)
    data[0:3] = bytes((0x0F, opcode, payload))
    data[19] = sum(data[:19]) & 0xFF
    return data


async def execute(address, slot, on):
    from bleak import BleakClient

    notifications = asyncio.Queue()
    async with BleakClient(address, timeout=15.0) as client:
        await client.start_notify(CHARACTERISTIC, lambda _, data: notifications.put_nowait(bytes(data)))

        async def request(opcode, value):
            while not notifications.empty():
                notifications.get_nowait()
            await client.write_gatt_char(CHARACTERISTIC, frame(opcode, value), response=True)
            async def receive():
                while True:
                    reply = await notifications.get()
                    if len(reply) == 20 and reply[0] == 0x0F and reply[1] == opcode and reply[2] == value:
                        if sum(reply[:19]) & 0xFF != reply[19]:
                            raise ValueError("Invalid BLE response checksum")
                        return reply
            return await asyncio.wait_for(receive(), 8)

        if on:
            status = await request(0x55, slot - 1)
            if status[6] not in (0, 4) or int.from_bytes(status[9:11], "big") == 0:
                raise RuntimeError("START rejected: slot is not idle with a battery")
        await request(0x05 if on else 0xFE, 1 << (slot - 1))
        for _ in range(5):
            await asyncio.sleep(1)
            status = await request(0x55, slot - 1)
            if status[6] >= 128:
                raise RuntimeError(f"Slot reports error {status[6]}; check charger")
            active = status[6] in (1, 2, 3)
            if active == on:
                return
        raise RuntimeError(f"Command acknowledged but slot state is {status[6]}; check charger")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("address")
    parser.add_argument("slot", type=int, choices=range(1, 5))
    parser.add_argument("action", choices=("ON", "OFF"))
    args = parser.parse_args()
    asyncio.run(execute(args.address, args.slot, args.action == "ON"))


if __name__ == "__main__":
    main()
