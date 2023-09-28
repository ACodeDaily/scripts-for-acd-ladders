const axios = require('axios');
const { time } = require('console');
const fs = require('fs');
const { start } = require('repl');
const mongoose = require('mongoose');

const observationTime = 16 * 31 * 24 * 60 * 60;			// total span of 16 months-> broken into 4 of 4 months each. 
const observationWindow = 4 * 31 * 24 * 60 * 60;
const improvementThreshold = 150;

const contestThreshold = 20;
const problemThreshold = 150;

const getEpochSecond = () => {
	return Math.floor(new Date().getTime() / 1000);
}
const populateAllActiveUsers = async() => {
	const response =await axios({
		method: 'get',
		url: 'https://codeforces.com/api/user.ratedList?activeOnly=true&includeRetired=false'
	});
	userData=response.data;
	fs.writeFileSync(`./cfusers.json`, JSON.stringify(userData));
	console.log("number of active users: ",userData.length);
	
}
const getRating = async (handle) => {
	const response = await axios({
		method: 'get',
		url: `https://codeforces.com/api/user.rating?handle=${handle}`,
	});
	return response.data.result;
};

const getSubmissions = async (handle) => {
	const response = await axios({
		method: 'get',
		url: `https://codeforces.com/api/user.status?handle=${handle}`,
	});
	return response.data.result;
}


// Iterative function to implement Binary Search
let binSearch = function (arr, x) {
  
    let start=0, end=arr.length-1;
         
    // Iterate while start not meets end
	let ans = arr[0].newRating;

    while (start<=end){
 
        // Find the mid index
        let mid=Math.floor((start + end)/2);
		
        if (arr[mid].ratingUpdateTimeSeconds<=x)
		{
			ans = arr[mid].newRating;
            start = mid + 1;
		}
        else
             end = mid - 1;
    }

	ans = Math.max(ans,800);
	ans = Math.round(ans/100)*100;

    return ans;
}

const getEligibleProblems = async (user) => {
	const { handle } = user;
	const now = getEpochSecond();
	const thresholdTime = now - observationTime;

	let rating = await getRating(handle);
	// let userRating = {...rating};

	let xrating = rating.filter(r => r.ratingUpdateTimeSeconds >= thresholdTime);
	if (xrating.length < contestThreshold) {
		return [];
	}

	let allSubmissions = await getSubmissions(handle);
	//---------------------changed for second version-----------------------------------------
	allSubmissions = allSubmissions.filter(s => s.creationTimeSeconds >= thresholdTime && s.verdict === 'OK');
	allSubmissions = allSubmissions.filter(s => s.author.participantType==='PRACTICE');
	//--------------------------------------------------------------------------------------
	const problemIds = new Set();
	let submissions = [];
	let submissionCount = 0;

	for (const submission of allSubmissions) {
		const key = getProblemKey(submission.problem);
		if (problemIds.has(key)) {
			continue;
		}
		problemIds.add(key);
		submissions.push(submission);

		//-------------------------changed for second version--------------------------
		submissionCount++;

		let problemRating = submission.problem.rating;
		let submissionTime = submission.creationTimeSeconds;
		
		let ratingBeforeSubmission = binSearch(rating,submissionTime);

		if(Math.abs(problemRating-ratingBeforeSubmission)>=700 || (problemRating-ratingBeforeSubmission)<=-400)
		{
			continue;
		}
		
		
		let count = 0;

		// const arr = {"-300": 1,"-200": 3,"-100": 6,"0":8,"100":9,"200":9,"300":8,"400":6,"500":3,"600":1};
		// count = arr.toString(problemRating-ratingBeforeSubmission);
		let arr = [1,3,6,8,9,9,8,6,3,1];
		for(let diff = -300; diff<=600; diff+=100)
		{
			if(problemRating-ratingBeforeSubmission===diff)
			{
				break;
			}
			count++;
		}


		for(let i=0; i<arr[count]; i++)
		{
			submissions.push(submission);
		}
		//------------------------------------------------------------------------------------
		
	}

	// if (submissions.length < problemThreshold) {
	// 	return [];
	// }

	if(submissionCount<problemThreshold){
		return [];
	}

	let eligibleSubmissions = [];
	for (let start = thresholdTime; start < now; start += observationWindow) {
		const end = start + observationWindow;
		const ratingWindow = rating.filter(r => r.ratingUpdateTimeSeconds >= start && r.ratingUpdateTimeSeconds < end);
		if (!ratingWindow.length) {
			continue;
		}
		const startRating = ratingWindow[0].newRating;
		const maxRating = Math.max(...ratingWindow.map(r => r.newRating));
		if (maxRating - startRating >= improvementThreshold) {
			eligibleSubmissions = [ ...eligibleSubmissions,
				...submissions.filter(s => s.creationTimeSeconds >= start && s.creationTimeSeconds < end) ];
		}
	}
	const eligibleProblems = eligibleSubmissions.map(sub => sub.problem);
	// console.log(`${handle} has ${eligibleProblems.length} eligible problems`);
	return eligibleProblems;
}

const getProblemKey = (problem) => {
	return `${problem.contestId}:${problem.index}`;
}

const getEligibleProblemsInBatch = async (users, problemMap, problemFreq, errCount, start, end, skippedUsers) => {
	console.log(`Processing batch ${start} to ${end}`);
	const last = Math.min(end, users.length);
	for (let i = start; i < last; i++) {
		const user = users[i];
		try {
			const problems = await getEligibleProblems(user);
			for (const problem of problems) {
				const problemKey = getProblemKey(problem);
				if (!problemMap[problemKey]) {
					problemMap[problemKey] = problem;
					problemFreq[problemKey] = 0;
				}
				problemFreq[problemKey]++;
			}
		} catch (err) {
			// console.log(`Error for ${user.handle}: ${err}`);
			if (!errCount[i]) errCount[i] = 0;
			errCount[i]++;
			if (errCount[i] <= 6) {
				await new Promise(resolve => setTimeout(resolve, 3000));
				i--;
			} else {
				skippedUsers.push(user);
			}
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	console.log(`Processed batch ${start} to ${end}`);
}

const getAllEligibleProblems = async (startFrom, doSkipped = false) => {
	const userFile = JSON.parse(fs.readFileSync('./cfusers.json'));
	let users = [...userFile.result];
	
	const errCount = {};
	let problemMap = {};
	let problemFreq = {};
	let skippedUsers = [];
	if (startFrom) {
		const checkpoint = JSON.parse(fs.readFileSync(`./checkpoints/checkpoint_${startFrom}.json`));
		problemMap = checkpoint.problemMap;
		problemFreq = checkpoint.problemFreq;
		skippedUsers = checkpoint.skippedUsers;
		if (doSkipped) {
			users = [...skippedUsers];
			skippedUsers = [];
		}
	} 
	else {
		startFrom = 0;
	}

	console.log('Processing users:' + users.length);
	const checkPointSize = 100;
	const batchSize = 20;
	let start = startFrom;
	if (doSkipped) {
		start = 0;
	}
	for (let i = start; i < users.length; i += checkPointSize) {
		const toWrite = {
			problemMap: problemMap,
			problemFreq: problemFreq,
			skippedUsers: skippedUsers,
		};
		let checkpoint = startFrom + i;
		fs.writeFileSync(`./checkpoints/checkpoint_${checkpoint}.json`, JSON.stringify(toWrite));
		console.log(`Checkpoint upto ${checkpoint} written, skipped users: ${skippedUsers.length}, problems: ${Object.keys(problemMap).length}`);

		let tasks = [];
		for (let j = 0; j < checkPointSize; j += batchSize) {
			tasks.push(getEligibleProblemsInBatch(users, problemMap, problemFreq, errCount, i + j, i + j + batchSize, skippedUsers));
		}
		await Promise.allSettled(tasks);
	}
	const toWrite = {
		problemMap: problemMap,
		problemFreq: problemFreq,
		skippedUsers: skippedUsers,
	};
	fs.writeFileSync(`./checkpoints/checkpoint_${users.length}.json`, JSON.stringify(toWrite));
	console.log('Done');
}

getAllEligibleProblems();
// getAllEligibleProblems(46014, true);

// const data1 = JSON.parse(fs.readFileSync('./checkpoints/checkpoint_46014.json'));
// const data2 = JSON.parse(fs.readFileSync('./checkpoints/checkpoint_48814.json'));

// console.log(Object.keys(data1.problemMap).length);
// console.log(Object.keys(data2.problemMap).length);


// DONT run this again.. it was already populated on 26th sep,2023
// populateAllActiveUsers();




/*
Changes for iteration 2! 
1. weighted averages for problems solved wrt ratings 
2. Select only those problems which have been upsolved/practiced as the ones solved in contests are unlikely to help in knowledge growth
3. 	



// mentioning the submissions response below.
                "participantType": "PRACTICE",
                "ghost": false,
                "startTimeSeconds": 1493391900
            },
            "programmingLanguage": "GNU C++17 (64)",
            "verdict": "WRONG_ANSWER",
*/