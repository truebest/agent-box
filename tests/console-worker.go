// Test-only placement control; marking unavailable leaves running actors alone.
package main

import (
	"context"
	"os"
	"time"

	"github.com/agent-substrate/substrate/internal/ateclient"
	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
)

func main() {
	if len(os.Args) != 3 || (os.Args[1] != "available" && os.Args[1] != "unavailable") {
		panic("usage: console-worker available|unavailable worker-id")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client, err := ateclient.NewClient(ctx, "", "", "", "", false)
	if err != nil {
		panic(err)
	}
	defer client.Close()
	worker := &pb.ObjectRef{Name: os.Args[2]}
	if os.Args[1] == "available" {
		_, err = client.MarkWorkerAvailable(ctx, &pb.MarkWorkerAvailableRequest{Worker: worker})
	} else {
		_, err = client.MarkWorkerUnavailable(ctx, &pb.MarkWorkerUnavailableRequest{Worker: worker})
	}
	if err != nil {
		panic(err)
	}
}
