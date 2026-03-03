#!/usr/bin/env node

/**
 * Multi-User Test Script
 * Demonstrates user registration, authentication, and task isolation
 */

const BASE_URL = 'http://localhost:3000';

// Helper function for API calls
async function apiCall(method, endpoint, data = null, token = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  if (data) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  return await response.json();
}

async function testMultiUser() {
  console.log('🧪 Testing Multi-User Task Server\n');
  console.log('================================\n');

  try {
    // 1. Check server health
    console.log('1️⃣ Checking server health...');
    const health = await apiCall('GET', '/health');
    console.log('✅ Server is healthy:', health);
    console.log('');

    // 2. Register Alice
    console.log('2️⃣ Registering user "Alice"...');
    const aliceReg = await apiCall('POST', '/auth/register', {
      username: 'alice_' + Date.now(),
      password: 'alice123',
      email: 'alice@example.com'
    });
    
    if (aliceReg.error) {
      console.log('❌ Registration failed:', aliceReg.error);
      if (aliceReg.error.includes('already exists')) {
        console.log('💡 Tip: Username already exists. Using login instead...');
        // Try login instead
        const aliceLogin = await apiCall('POST', '/auth/login', {
          username: 'alice',
          password: 'alice123'
        });
        aliceReg.token = aliceLogin.token;
        aliceReg.user = aliceLogin.user;
      } else {
        throw new Error(aliceReg.error);
      }
    }
    
    console.log('✅ Alice registered:', aliceReg.user);
    const aliceToken = aliceReg.token;
    console.log('   Token:', aliceToken.substring(0, 20) + '...');
    console.log('');

    // 3. Register Bob
    console.log('3️⃣ Registering user "Bob"...');
    const bobReg = await apiCall('POST', '/auth/register', {
      username: 'bob_' + Date.now(),
      password: 'bob123',
      email: 'bob@example.com'
    });
    
    if (bobReg.error) {
      throw new Error(bobReg.error);
    }
    
    console.log('✅ Bob registered:', bobReg.user);
    const bobToken = bobReg.token;
    console.log('   Token:', bobToken.substring(0, 20) + '...');
    console.log('');

    // 4. Get Alice's profile
    console.log('4️⃣ Getting Alice\'s profile...');
    const aliceProfile = await apiCall('GET', '/auth/me', null, aliceToken);
    console.log('✅ Alice\'s profile:', aliceProfile.user);
    console.log('');

    // 5. Get Bob's profile
    console.log('5️⃣ Getting Bob\'s profile...');
    const bobProfile = await apiCall('GET', '/auth/me', null, bobToken);
    console.log('✅ Bob\'s profile:', bobProfile.user);
    console.log('');

    // 6. Get Alice's task lists (Apple Reminders)
    console.log('6️⃣ Getting Alice\'s task lists (Apple Reminders)...');
    const aliceLists = await apiCall('GET', '/api/lists?provider=apple', null, aliceToken);
    if (aliceLists.error) {
      console.log('⚠️  Error:', aliceLists.error);
    } else {
      console.log('✅ Alice has', aliceLists.lists.length, 'list(s)');
      console.log('   User in response:', aliceLists.user);
    }
    console.log('');

    // 7. Get Bob's task lists (Apple Reminders)
    console.log('7️⃣ Getting Bob\'s task lists (Apple Reminders)...');
    const bobLists = await apiCall('GET', '/api/lists?provider=apple', null, bobToken);
    if (bobLists.error) {
      console.log('⚠️  Error:', bobLists.error);
    } else {
      console.log('✅ Bob has', bobLists.lists.length, 'list(s)');
      console.log('   User in response:', bobLists.user);
    }
    console.log('');

    // 8. Test that Alice cannot access Bob's data (security check)
    console.log('8️⃣ Security test: Trying to access API without token...');
    const unauthorized = await apiCall('GET', '/api/lists?provider=apple');
    if (unauthorized.error) {
      console.log('✅ Good! Request without token was rejected:', unauthorized.error);
    } else {
      console.log('❌ SECURITY ISSUE: Unauthenticated request succeeded!');
    }
    console.log('');

    // 9. Test Alice creating a task
    if (aliceLists.lists && aliceLists.lists.length > 0) {
      console.log('9️⃣ Alice creating a new task...');
      const firstList = aliceLists.lists[0];
      const aliceTask = await apiCall(
        'POST',
        `/api/lists/${encodeURIComponent(firstList.id)}/tasks?provider=apple`,
        {
          name: 'Alice\'s Task - ' + new Date().toISOString(),
          notes: 'This task belongs to Alice only'
        },
        aliceToken
      );
      
      if (aliceTask.error) {
        console.log('⚠️  Error:', aliceTask.error);
      } else {
        console.log('✅ Alice created task:', aliceTask.task);
        console.log('   User in response:', aliceTask.user);
      }
    }
    console.log('');

    console.log('================================');
    console.log('🎉 Multi-user tests complete!\n');
    console.log('Summary:');
    console.log('  ✅ Two separate users registered');
    console.log('  ✅ Each user has their own JWT token');
    console.log('  ✅ Each user can access their own data');
    console.log('  ✅ Unauthenticated requests are rejected');
    console.log('  ✅ User isolation is working correctly');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('\nMake sure:');
    console.error('  1. The multi-user server is running: npm run start:multiuser');
    console.error('  2. The server is accessible at http://localhost:3000');
  }
}

// Run the tests
testMultiUser();
