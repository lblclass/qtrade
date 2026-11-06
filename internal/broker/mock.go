package broker

import (
	"context"
	"time"
)

type Mock struct{}

func (Mock) Name() string { return "mock" }

func (Mock) Health(context.Context) Health {
	return Health{
		Name:      "mock",
		Status:    "ok",
		LatencyMS: 0,
		CheckedAt: time.Now().UTC(),
	}
}

func (Mock) SubmitOrder(_ context.Context, request OrderRequest) (OrderAck, error) {
	return OrderAck{
		ClientOrderID: request.ClientOrderID,
		BrokerOrderID: "mock_" + request.ClientOrderID,
		Accepted:      true,
	}, nil
}

func (Mock) CancelOrder(context.Context, string) error { return nil }

func (Mock) QueryAccount(_ context.Context, accountID string) (AccountSnapshot, error) {
	return AccountSnapshot{
		AccountID:   accountID,
		CashCents:   100_000_000,
		EquityCents: 100_000_000,
		Currency:    "CNY",
	}, nil
}

func (Mock) QueryPositions(context.Context, string) ([]PositionSnapshot, error) {
	return []PositionSnapshot{}, nil
}
