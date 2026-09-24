import { describe, expect, test } from "bun:test";
import { MemoryLedger, type MemoryReservation } from "@butui/core";

describe("MemoryLedger", () => {
  test("grant / release 更新 used 与 peak", () => {
    const ledger = new MemoryLedger({ totalBytes: 100 });
    const decision = ledger.reserve({
      owner: "transcript",
      class: "hot",
      bytes: 40,
      priority: 1,
    });
    expect(decision.status).toBe("granted");
    const reservation = (decision as { reservation: MemoryReservation }).reservation;

    expect(ledger.stats()).toMatchObject({
      reservations: 1,
      usedBytes: 40,
      peakBytes: 40,
    });
    reservation.release();
    expect(ledger.stats().usedBytes).toBe(0);
  });

  test("class limit 与 pinned-limit 独立生效", () => {
    const ledger = new MemoryLedger({
      totalBytes: 100,
      classLimits: { hot: 50, pinned: 10 },
    });
    expect(
      ledger.reserve({
        owner: "a",
        class: "hot",
        bytes: 40,
        priority: 1,
      }).status
    ).toBe("granted");
    expect(
      ledger.reserve({
        owner: "b",
        class: "hot",
        bytes: 20,
        priority: 1,
      })
    ).toEqual({ status: "rejected", reason: "budget" });
    expect(
      ledger.reserve({
        owner: "pin",
        class: "pinned",
        bytes: 20,
        priority: 0,
      })
    ).toEqual({ status: "rejected", reason: "pinned-limit" });
  });

  test("预算不足时按优先级返回 spill candidates", () => {
    const ledger = new MemoryLedger({ totalBytes: 100 });
    ledger.reserve({
      owner: "ephemeral",
      class: "ephemeral",
      bytes: 20,
      priority: 3,
      spillable: true,
    });
    ledger.reserve({
      owner: "warm",
      class: "warm",
      bytes: 30,
      priority: 2,
      spillable: true,
    });
    ledger.reserve({
      owner: "hot",
      class: "hot",
      bytes: 40,
      priority: 0,
    });

    const decision = ledger.reserve({
      owner: "cold",
      class: "cold",
      bytes: 30,
      priority: 1,
    });
    expect(decision.status).toBe("spill-required");
    expect(decision).toMatchObject({
      status: "spill-required",
      candidates: ["mem-1", "mem-2"],
    });
    expect(ledger.stats().spillRequired).toBe(1);
  });

  test("resize 增加预算不足时保持原 size", () => {
    const ledger = new MemoryLedger({ totalBytes: 100 });
    const decision = ledger.reserve({
      owner: "hot",
      class: "hot",
      bytes: 50,
      priority: 1,
    });
    const reservation = (decision as { reservation: MemoryReservation }).reservation;

    expect(reservation.resize(120)).toEqual({
      status: "rejected",
      reason: "budget",
    });
    expect(reservation.bytes).toBe(50);
    expect(reservation.resize(20).status).toBe("granted");
    expect(reservation.bytes).toBe(20);
  });

  test("pressure 暴露 class 明细与总预算比例", () => {
    const ledger = new MemoryLedger({ totalBytes: 200 });
    ledger.reserve({
      owner: "hot",
      class: "hot",
      bytes: 50,
      priority: 1,
    });
    ledger.reserve({
      owner: "cold",
      class: "cold",
      bytes: 25,
      priority: 2,
    });

    expect(ledger.pressure()).toEqual({
      usedBytes: 75,
      totalBytes: 200,
      ratio: 0.375,
      byClass: {
        ephemeral: 0,
        hot: 50,
        warm: 0,
        cold: 25,
        pinned: 0,
      },
    });
  });
});
