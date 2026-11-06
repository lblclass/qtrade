from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from enum import Enum

ZERO = Decimal("0")


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"


class OrderStatus(str, Enum):
    PENDING = "pending"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELED = "canceled"
    REJECTED = "rejected"


@dataclass(frozen=True)
class Bar:
    symbol: str
    ts: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    amount: Decimal = ZERO
    limit_up: Decimal | None = None
    limit_down: Decimal | None = None
    suspended: bool = False

    def __post_init__(self) -> None:
        if self.high < self.low:
            raise ValueError("bar high must be greater than or equal to low")
        if not (self.low <= self.open <= self.high):
            raise ValueError("bar open must be within low and high")
        if not (self.low <= self.close <= self.high):
            raise ValueError("bar close must be within low and high")
        if self.volume < 0:
            raise ValueError("bar volume must be non-negative")


@dataclass(frozen=True)
class OrderIntent:
    symbol: str
    side: Side
    quantity: int
    order_type: OrderType = OrderType.MARKET
    limit_price: Decimal | None = None
    client_order_id: str | None = None
    reason: str = ""


@dataclass
class Order:
    order_id: str
    client_order_id: str
    symbol: str
    side: Side
    order_type: OrderType
    quantity: int
    limit_price: Decimal | None
    created_at: datetime
    remaining: int
    status: OrderStatus = OrderStatus.PENDING
    reject_reason: str = ""

    @property
    def is_open(self) -> bool:
        return self.status in (OrderStatus.PENDING, OrderStatus.PARTIALLY_FILLED) and self.remaining > 0


@dataclass(frozen=True)
class Fill:
    fill_id: str
    order_id: str
    symbol: str
    side: Side
    quantity: int
    price: Decimal
    commission: Decimal
    stamp_tax: Decimal
    transfer_fee: Decimal
    ts: datetime

    @property
    def notional(self) -> Decimal:
        return self.price * self.quantity

    @property
    def total_fees(self) -> Decimal:
        return self.commission + self.stamp_tax + self.transfer_fee


@dataclass
class PositionLot:
    quantity: int
    cost_price: Decimal
    available_on: date


@dataclass
class Position:
    symbol: str
    lots: list[PositionLot] = field(default_factory=list)
    last_price: Decimal = ZERO

    @property
    def quantity(self) -> int:
        return sum(lot.quantity for lot in self.lots)

    @property
    def avg_cost(self) -> Decimal:
        if self.quantity == 0:
            return ZERO
        total = sum(lot.cost_price * lot.quantity for lot in self.lots)
        return total / self.quantity

    @property
    def market_value(self) -> Decimal:
        price = self.last_price if self.last_price > 0 else self.avg_cost
        return price * self.quantity

    def available_quantity(self, today: date) -> int:
        return sum(lot.quantity for lot in self.lots if lot.available_on <= today)

    def add(self, quantity: int, price: Decimal, fees: Decimal, available_on: date) -> None:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        total_cost = price * quantity + fees
        self.lots.append(
            PositionLot(
                quantity=quantity,
                cost_price=total_cost / quantity,
                available_on=available_on,
            )
        )
        self.last_price = price

    def remove(self, quantity: int, today: date) -> Decimal | None:
        if quantity <= 0:
            return None
        if self.available_quantity(today) < quantity:
            return None

        remaining = quantity
        cost = ZERO
        for lot in list(self.lots):
            if remaining == 0:
                break
            if lot.available_on > today:
                continue
            taken = min(lot.quantity, remaining)
            cost += lot.cost_price * taken
            lot.quantity -= taken
            remaining -= taken
            if lot.quantity == 0:
                self.lots.remove(lot)
        return cost


@dataclass
class Portfolio:
    cash: Decimal
    initial_cash: Decimal
    positions: dict[str, Position] = field(default_factory=dict)
    realized_pnl: Decimal = ZERO

    def equity(self) -> Decimal:
        return self.cash + sum(position.market_value for position in self.positions.values())

