import './style.css';
import './review.css'
import $ from 'jquery';
import { schedule, ReviewResponse, textInterval } from './lib/scheduler';
import { DEFAULT_SETTINGS } from './lib/settings';

window.addEventListener('load', () => {
  document.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      $('#card-separator').removeClass('hidden');
      $('#card-back').removeClass('hidden');
    }
  });

  let currentCardIndex = 0;
  // // @ts-ignore
  // let cards = window.api.getReviewCards();

  let cards = [
    {
      front: 'This is the front of card 1',
      back: 'This is the back of card 1',
      interval: 1,
      ease: 250
    },
    {  
      front: 'This is the front of card 2',
      back: 'This is the back of card 2',
      interval: 1,
      ease: 250
    }
  ];

  function showCard() {
    let currentCard = cards[currentCardIndex];
    $('#card-front').text(currentCard.front);
    $('#card-back').text(currentCard.back);
    $('#card-separator').addClass('hidden');
    $('#card-back').addClass('hidden');
  }

  function updateIntervalDisplay(interval: number) {
    $('#response div p').each((i, el) => {
      let text = $(el).text();
      if (text.includes('d')) {
        let days = parseInt(text);
        $(el).text(textInterval(interval + days, false));
      }
    });
  }

  function processReview(response: ReviewResponse) {
    let currentCard = cards[currentCardIndex];
    let result = schedule(response, currentCard.interval, currentCard.ease, 0, DEFAULT_SETTINGS);
    console.log('review', result.interval, result.ease)
    currentCard.interval = result.interval;
    currentCard.ease = result.ease;
    
    currentCardIndex = (currentCardIndex + 1) % cards.length;
    showCard();
    updateIntervalDisplay(currentCard.interval);
  }

  $('#again').on('click', () => {
    processReview(ReviewResponse.Again);
  });

  $('#hard').on('click', () => {
    processReview(ReviewResponse.Hard);
  });

  $('#good').on('click', () => {
    processReview(ReviewResponse.Good);
  });

  $('#easy').on('click', () => {
    processReview(ReviewResponse.Easy);
  });

  document.addEventListener('keydown', (event) => {
    switch(event.key) {
      case 'd':
        processReview(ReviewResponse.Again);
        break;
      case 'f':
        processReview(ReviewResponse.Hard);
        break;
      case 'j':
        processReview(ReviewResponse.Good);
        break;
      case 'k':
        processReview(ReviewResponse.Easy);
        break;
    }
  });

  showCard();
  updateIntervalDisplay(cards[currentCardIndex].interval);
});