FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/qtrade-api ./cmd/qtrade-api

FROM alpine:3.21

RUN adduser -D -H -u 10001 qtrade
COPY --from=build /out/qtrade-api /usr/local/bin/qtrade-api
USER qtrade
EXPOSE 8080
ENTRYPOINT ["qtrade-api"]

