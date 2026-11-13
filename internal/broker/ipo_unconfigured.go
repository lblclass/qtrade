package broker

import (
	"context"
	"fmt"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
)

// QMTIPO is the placeholder for 迅投 QMT / miniQMT (xtquant). MiniQMT exposes a
// local Python sidecar; the Go control plane would submit subscription orders
// through an HTTP bridge instead of calling xtquant directly.
type QMTIPO struct {
	endpoint string
}

func NewQMTIPO(endpoint string) *QMTIPO { return &QMTIPO{endpoint: endpoint} }

func (q *QMTIPO) Name() string { return "qmt" }

func (q *QMTIPO) Health(context.Context) Health {
	status := "unconfigured"
	message := "未配置 QMT/miniQMT：需要在券商开通权限并部署 xtquant sidecar"
	if q.endpoint != "" {
		status = "unconfigured"
		message = fmt.Sprintf("已填写 sidecar 地址 %s，但尚未完成连接与账号绑定", q.endpoint)
	}
	return Health{Name: "qmt", Status: status, Message: message, CheckedAt: time.Now().UTC()}
}

func (q *QMTIPO) ListOffers(context.Context) ([]domain.IPOOffer, error) {
	return nil, fmt.Errorf("%w: QMT 通道需要券商开通新债/新股申购权限", ErrNotConfigured)
}

func (q *QMTIPO) Limits(context.Context, string) ([]domain.IPOLimit, error) {
	return nil, fmt.Errorf("%w: QMT 通道未配置资金账号", ErrNotConfigured)
}

func (q *QMTIPO) Subscribe(context.Context, IPORequest) (IPOAck, error) {
	return IPOAck{}, fmt.Errorf("%w: QMT 通道未连接，请先提供券商、资金账号与 xtquant sidecar 地址", ErrNotConfigured)
}

func (q *QMTIPO) Settle(context.Context, domain.IPOSubscription) (IPOAllotment, error) {
	return IPOAllotment{}, fmt.Errorf("%w: QMT 通道未连接，无法查询中签结果", ErrNotConfigured)
}

// PtradeIPO is the placeholder for 恒生 Ptrade, which runs Python strategies
// inside the broker's own environment and exposes a dedicated new-issue API.
type PtradeIPO struct {
	endpoint string
}

func NewPtradeIPO(endpoint string) *PtradeIPO { return &PtradeIPO{endpoint: endpoint} }

func (p *PtradeIPO) Name() string { return "ptrade" }

func (p *PtradeIPO) Health(context.Context) Health {
	message := "未配置 Ptrade：需要在券商开通 Ptrade 权限并申请 API 凭证"
	if p.endpoint != "" {
		message = fmt.Sprintf("已填写网关地址 %s，但尚未完成 OAuth 与账号绑定", p.endpoint)
	}
	return Health{Name: "ptrade", Status: "unconfigured", Message: message, CheckedAt: time.Now().UTC()}
}

func (p *PtradeIPO) ListOffers(context.Context) ([]domain.IPOOffer, error) {
	return nil, fmt.Errorf("%w: Ptrade 通道未开通", ErrNotConfigured)
}

func (p *PtradeIPO) Limits(context.Context, string) ([]domain.IPOLimit, error) {
	return nil, fmt.Errorf("%w: Ptrade 通道未开通", ErrNotConfigured)
}

func (p *PtradeIPO) Subscribe(context.Context, IPORequest) (IPOAck, error) {
	return IPOAck{}, fmt.Errorf("%w: Ptrade 通道未连接，请先提供券商与 API 凭证", ErrNotConfigured)
}

func (p *PtradeIPO) Settle(context.Context, domain.IPOSubscription) (IPOAllotment, error) {
	return IPOAllotment{}, fmt.Errorf("%w: Ptrade 通道未开通，无法查询中签结果", ErrNotConfigured)
}
