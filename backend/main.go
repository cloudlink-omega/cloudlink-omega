package main

import (
	"sync"

	api "github.com/mikedev101/cloudlink-omega/backend/pkg/api"
	dm "github.com/mikedev101/cloudlink-omega/backend/pkg/data"

	// _ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

func main() {
	/*
		// Load the .env file
		err := godotenv.Load(".env")
		if err != nil {
			log.Fatal("Error loading .env file")
			os.Exit(1)
		}

		// Insert this statement into dm.New() using "mysql" driver
			fmt.Sprintf(
					"%s:%s@tcp(%s)/%s",
					os.Getenv("DB_USER"),
					os.Getenv("DB_PASS"),
					os.Getenv("DB_HOST"),
					os.Getenv("DATABASE"),
				)
	*/

	// Initialize data manager
	mgr := dm.New(
		"sqlite",
		"file:./test.db?_pragma=foreign_keys(1)", // Use SQLite for testing/development purposes only
	)

	// Create wait group
	var wg sync.WaitGroup

	// Start REST API
	wg.Add(1)
	go func() {
		defer wg.Done()

		err := api.RunServer(3000, mgr)
		if err != nil {
			panic(err)
		}
	}()

	// Wait for all services to stop
	wg.Wait()
}
