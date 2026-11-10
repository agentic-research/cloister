// Command dolt-grpc-demo is the gRPC half of the cloister-991e65 demo: a
// service that knows only two loopback addresses. It dials the database at
// -db and serves gRPC on -listen. Inside a cloister microVM both are guest
// loopback ports that the confinement document presents (confinement/v1 §6
// guestPort): -db is a connect grant on the database's socket, -listen is a
// bind grant the host reaches. Nothing in this program knows that.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	"github.com/agentic-research/cloister/tools/dolt-grpc-demo/ordersv1"
)

type server struct {
	ordersv1.UnimplementedOrdersServer
	db *sql.DB
}

func (s *server) Get(ctx context.Context, req *ordersv1.GetRequest) (*ordersv1.Order, error) {
	var order ordersv1.Order
	err := s.db.QueryRowContext(ctx,
		"SELECT id, msg, active_branch() FROM orders WHERE id = ?", req.GetId(),
	).Scan(&order.Id, &order.Msg, &order.Branch)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, status.Errorf(codes.NotFound, "no order %d", req.GetId())
	}
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "database: %v", err)
	}
	return &order, nil
}

// open dials the database until it answers or the deadline passes. A fresh
// connection through the microVM's presented port can see EOF while the peer
// is still coming up (LLO ley-line-open-a915e3), so a failed ping is retried
// rather than treated as final.
func open(dsn string, deadline time.Duration) (*sql.DB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	stop := time.Now().Add(deadline)
	for {
		err = db.Ping()
		if err == nil {
			return db, nil
		}
		if time.Now().After(stop) {
			db.Close()
			return nil, fmt.Errorf("database did not answer within %s: %w", deadline, err)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func seed(addr string) error {
	cfg := mysql.NewConfig()
	cfg.User, cfg.Net, cfg.Addr = "root", "tcp", addr
	db, err := open(cfg.FormatDSN(), 30*time.Second)
	if err != nil {
		return err
	}
	defer db.Close()
	for _, stmt := range []string{
		"CREATE DATABASE IF NOT EXISTS orders",
		"CREATE TABLE IF NOT EXISTS orders.orders (id INT PRIMARY KEY, msg VARCHAR(128))",
		"INSERT IGNORE INTO orders.orders VALUES (1, 'read from Dolt in another microVM')",
	} {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("%s: %w", stmt, err)
		}
	}
	return nil
}

func main() {
	dbAddr := flag.String("db", "127.0.0.1:3306", "MySQL-wire database address")
	listen := flag.String("listen", "127.0.0.1:50051", "gRPC listen address")
	flag.Parse()

	if err := seed(*dbAddr); err != nil {
		log.Printf("seed: %v", err)
		os.Exit(2)
	}
	cfg := mysql.NewConfig()
	cfg.User, cfg.Net, cfg.Addr, cfg.DBName = "root", "tcp", *dbAddr, "orders"
	db, err := open(cfg.FormatDSN(), 30*time.Second)
	if err != nil {
		log.Printf("open: %v", err)
		os.Exit(2)
	}
	lis, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Printf("listen: %v", err)
		os.Exit(3)
	}
	srv := grpc.NewServer()
	ordersv1.RegisterOrdersServer(srv, &server{db: db})
	reflection.Register(srv)
	if err := srv.Serve(lis); err != nil {
		log.Printf("serve: %v", err)
		os.Exit(4)
	}
}
